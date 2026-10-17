// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockERC20 is IERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

contract ProfitTarget {
    function sendProfit(address token, address vault, uint256 amount) external {
        MockERC20(token).mint(vault, amount);
    }
}

contract MockBalancerVault {
    function flashLoan(
        address payable recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external {
        for (uint256 i = 0; i < tokens.length; i++) {
            MockERC20(tokens[i]).mint(recipient, amounts[i]);
        }
        uint256[] memory feeAmounts = new uint256[](tokens.length);
        AgentVault(recipient).receiveFlashLoan(tokens, amounts, feeAmounts, userData);
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 owed = amounts[i] + feeAmounts[i];
            require(MockERC20(tokens[i]).balanceOf(address(this)) >= owed, "repay");
        }
    }
}

contract MockAaveV3Pool {
    function flashLoanSimple(
        address payable receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 /* referralCode */
    ) external {
        MockERC20(asset).mint(receiverAddress, amount);
        uint256 premium = amount * 5 / 10000;
        AgentVault(receiverAddress).executeOperation(asset, amount, premium, receiverAddress, params);
        uint256 owed = amount + premium;
        require(MockERC20(asset).balanceOf(receiverAddress) >= owed, "insufficient for repayment");
        MockERC20(asset).transferFrom(receiverAddress, address(this), owed);
    }
}

contract AgentVaultProfitRoutingTest is Test {
    AgentVault public vault;
    MockERC20 public tokenA;
    MockERC20 public tokenB;
    MockBalancerVault public balancerVault;
    MockAaveV3Pool public aavePool;
    ProfitTarget public profitTarget;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public profitRecipient = makeAddr("profitRecipient");

    function setUp() public {
        tokenA = new MockERC20("TokenA", "TKA", 18);
        tokenB = new MockERC20("TokenB", "TKB", 18);
        balancerVault = new MockBalancerVault();
        aavePool = new MockAaveV3Pool();
        profitTarget = new ProfitTarget();

        vm.startPrank(owner);
        vault = new AgentVault(owner, operator, profitRecipient, address(balancerVault), address(aavePool), block.chainid);
        vault.setWhitelistedTarget(address(profitTarget), true);
        vault.setWhitelistedTarget(address(tokenA), true); // whitelist tokenA as a target for drain test
        tokenA.mint(address(vault), 10_000e18);
        vm.stopPrank();
    }

    // ═══ B1: Ordinary execute() principal drain ═══════════════════════

    function test_B1_ExecuteDrainsProtectedPrincipalBeforeFix() public {
        // After remediation: execute() checks ALL registered protected tokens.
        // Before remediation: _tokensToCheckAfterCall() returned empty.
        // Now: protectToken() auto-registers, so the token is in the effective set.
        vm.prank(owner);
        vault.protectToken(address(tokenA), 10_000e18);

        // Operator calls tokenA.transfer(profitRecipient, 1000e18) via execute()
        bytes memory data = abi.encodeWithSelector(IERC20.transfer.selector, profitRecipient, 1000e18);
        vm.prank(operator);
        vm.expectRevert(); // ProtectedPrincipalBreached
        vault.execute(address(tokenA), data);

        // Verify balance is intact
        assertEq(tokenA.balanceOf(address(vault)), 10_000e18, "vault balance intact");
        assertEq(tokenA.balanceOf(profitRecipient), 0, "no drain");
    }

    function test_B1_ExecuteRoutesProfitAfterFix() public {
        // Register tokenA, protect 10_000e18
        vm.prank(owner);
        vault.protectToken(address(tokenA), 10_000e18);

        // Execute a call that generates 500e18 profit
        bytes memory data = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenA), address(vault), 500e18);
        vm.prank(operator);
        vault.execute(address(profitTarget), data);

        // 500e18 profit should be routed to profitRecipient
        assertEq(tokenA.balanceOf(profitRecipient), 500e18, "profit routed");
        assertEq(tokenA.balanceOf(address(vault)), 10_000e18, "vault retains protected principal");
    }

    // ═══ B2: Balancer snapshot arithmetic ═════════════════════════════

    function test_B2_BalancerProfitInBorrowedTokenRouted() public {
        // Use tokenB (unfunded) as the borrowed token to get clean arithmetic
        vm.prank(owner);
        vault.protectToken(address(tokenB), 0); // register but protect 0

        uint256 borrowAmount = 1000e18;
        uint256 profitAmount = 100e18;

        address[] memory targets = new address[](1);
        targets[0] = address(profitTarget);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), profitAmount);
        bytes memory userData = abi.encode(targets, datas);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        uint256 recipientBefore = tokenB.balanceOf(profitRecipient);
        vm.prank(operator);
        vault.balancerFlashLoan(tokens, amounts, userData);

        // After fix: pre-loan baseline = 0 (tokenB was unfunded)
        // After swaps: vault has 1000 + 100 = 1100
        // After repayment: vault has 100
        // Profit = 100 - max(0, 0) = 100 -> routed
        assertEq(tokenB.balanceOf(profitRecipient) - recipientBefore, 100e18, "profit routed correctly");
        assertEq(tokenB.balanceOf(address(vault)), 0, "vault retains 0 (all profit routed)");
    }

    function test_B2_BalancerNoProfitNoRouting() public {
        vm.prank(owner);
        vault.protectToken(address(tokenB), 0);

        uint256 borrowAmount = 1000e18;
        address[] memory targets = new address[](0);
        bytes[] memory datas = new bytes[](0);
        bytes memory userData = abi.encode(targets, datas);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        uint256 recipientBefore = tokenB.balanceOf(profitRecipient);
        vm.prank(operator);
        vault.balancerFlashLoan(tokens, amounts, userData);

        assertEq(tokenB.balanceOf(profitRecipient), recipientBefore, "no profit routed");
        assertEq(tokenB.balanceOf(address(vault)), 0, "vault has 0 (borrowed + repaid)");
    }

    // ═══ B3+B4: Aave mock with post-callback transferFrom ═════════════

    function test_B3_AaveProfitInBorrowedTokenRouted() public {
        vm.prank(owner);
        vault.protectToken(address(tokenB), 0);

        uint256 borrowAmount = 1000e18;
        uint256 profitAmount = 100e18;
        uint256 premium = borrowAmount * 5 / 10000; // 0.5e18

        address[] memory targets = new address[](1);
        targets[0] = address(profitTarget);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), profitAmount + premium);
        bytes memory params = abi.encode(targets, datas);

        uint256 recipientBefore = tokenB.balanceOf(profitRecipient);
        vm.prank(operator);
        vault.aaveFlashLoan(address(tokenB), borrowAmount, params);

        // After fix: pre-loan baseline = 0
        // After swaps: vault has 1000 + 100.5 = 1100.5
        // Aave pulls 1000.5 (amount + premium)
        // Projected post-repayment = 1100.5 - 1000.5 = 100
        // Profit = 100 - max(0, 0) = 100 -> routed
        assertEq(tokenB.balanceOf(profitRecipient) - recipientBefore, 100e18, "Aave profit routed");
        assertEq(tokenB.balanceOf(address(vault)), 0, "vault retains 0");
    }

    function test_B3_AaveNonzeroPremiumProtected() public {
        // Borrow with no profit — premium must be covered by vault's own funds
        vm.prank(owner);
        vault.protectToken(address(tokenB), 0);
        tokenB.mint(address(vault), 1e18); // give vault 1 tokenB to cover premium

        uint256 borrowAmount = 1000e18;
        uint256 premium = borrowAmount * 5 / 10000; // 0.5e18

        address[] memory targets = new address[](0);
        bytes[] memory datas = new bytes[](0);
        bytes memory params = abi.encode(targets, datas);

        uint256 vaultBefore = tokenB.balanceOf(address(vault));
        vm.prank(operator);
        vault.aaveFlashLoan(address(tokenB), borrowAmount, params);

        // Vault had 1e18, borrowed 1000, repaid 1000.5 = 0.5e18 remaining
        assertEq(tokenB.balanceOf(address(vault)), 0.5e18, "vault retains 0.5 after premium");
    }

    function test_B3_AaveRepaymentFailureReverts() public {
        // No profit and no vault funds — can't repay premium
        vm.prank(owner);
        vault.protectToken(address(tokenB), 0);

        uint256 borrowAmount = 1000e18;
        address[] memory targets = new address[](0);
        bytes[] memory datas = new bytes[](0);
        bytes memory params = abi.encode(targets, datas);

        vm.prank(operator);
        vm.expectRevert(); // FlashLoanRepayFailed (available < owed)
        vault.aaveFlashLoan(address(tokenB), borrowAmount, params);
    }

    // ═══ B4: Cross-token profits ═════════════════════════════════════

    function test_B4_BalancerCrossTokenProfitRoutedAfterFix() public {
        // Register tokenB as a protected token so it's in the effective set
        vm.prank(owner);
        vault.registerToken(address(tokenB));

        uint256 borrowAmount = 1000e18;
        uint256 profitInB = 200e18;

        address[] memory targets = new address[](1);
        targets[0] = address(profitTarget);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), profitInB);
        bytes memory userData = abi.encode(targets, datas);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenA);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        uint256 recipientBBefore = tokenB.balanceOf(profitRecipient);
        vm.prank(operator);
        vault.balancerFlashLoan(tokens, amounts, userData);

        // After fix: tokenB is registered, so it's in the effective set
        // Pre-loan baseline for tokenB = 0
        // After swaps: vault has 200e18 of tokenB
        // Profit = 200 - max(0, 0) = 200 -> routed
        assertEq(tokenB.balanceOf(profitRecipient) - recipientBBefore, 200e18, "cross-token profit routed");
        assertEq(tokenB.balanceOf(address(vault)), 0, "vault retains 0 tokenB");
    }

    function test_B4_AaveCrossTokenProfitRoutedAfterFix() public {
        vm.prank(owner);
        vault.registerToken(address(tokenB));

        uint256 borrowAmount = 1000e18;
        uint256 profitInB = 200e18;
        uint256 premium = borrowAmount * 5 / 10000;

        // Profit in tokenB covers the premium in tokenA
        address[] memory targets = new address[](1);
        targets[0] = address(profitTarget);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), profitInB);
        // Also need to cover tokenA premium — mint profit in tokenA too
        // Actually we need tokenA for repayment. Let's mint profitInA = premium to cover.
        // But we only have one target. Let's use two targets.
        address[] memory targets2 = new address[](2);
        targets2[0] = address(profitTarget);
        targets2[1] = address(profitTarget);
        bytes[] memory datas2 = new bytes[](2);
        datas2[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), profitInB);
        datas2[1] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenA), address(vault), premium);
        bytes memory params = abi.encode(targets2, datas2);

        uint256 recipientBBefore = tokenB.balanceOf(profitRecipient);
        vm.prank(operator);
        vault.aaveFlashLoan(address(tokenA), borrowAmount, params);

        // tokenB profit routed
        assertEq(tokenB.balanceOf(profitRecipient) - recipientBBefore, 200e18, "Aave cross-token profit routed");
    }

    // ═══ B4: Protected token not in borrowed list ═════════════════════

    function test_B4_ProtectedTokenNotInBorrowedList() public {
        // tokenA is protected (10_000e18) but not borrowed.
        // Flashloan tokenB, make profit in tokenB.
        // tokenA should still be checked for protected principal.
        vm.startPrank(owner);
        vault.protectToken(address(tokenA), 10_000e18);
        vault.registerToken(address(tokenB));
        vm.stopPrank();

        uint256 borrowAmount = 1000e18;
        uint256 profitInB = 200e18;

        address[] memory targets = new address[](1);
        targets[0] = address(profitTarget);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), profitInB);
        bytes memory userData = abi.encode(targets, datas);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        vm.prank(operator);
        vault.balancerFlashLoan(tokens, amounts, userData);

        // tokenA is still intact (protected principal enforced)
        assertEq(tokenA.balanceOf(address(vault)), 10_000e18, "protected tokenA intact");
        // tokenB profit routed
        assertEq(tokenB.balanceOf(profitRecipient), 200e18, "tokenB profit routed");
    }

    // ═══ C8: Operator revocation ═════════════════════════════════════

    function test_C8_RevokeOperator() public {
        vm.prank(owner);
        vault.revokeOperator();

        // All operator functions should revert
        bytes memory data = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenA), address(vault), 100e18);
        vm.prank(operator);
        vm.expectRevert(AgentVault.OperatorRevokedError.selector);
        vault.execute(address(profitTarget), data);
    }

    function test_C8_SetOperatorRejectsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        vault.setOperator(address(0));
    }

    function test_C8_RevokeThenSetNewOperator() public {
        address newOp = makeAddr("newOp");
        vm.startPrank(owner);
        vault.revokeOperator();
        vault.setOperator(newOp);
        vm.stopPrank();

        // Old operator can't call
        bytes memory data = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenA), address(vault), 100e18);
        vm.prank(operator);
        vm.expectRevert(AgentVault.OnlyOperator.selector);
        vault.execute(address(profitTarget), data);

        // New operator can call
        vm.prank(newOp);
        vault.execute(address(profitTarget), data);
    }

    // ═══ C9: gasReserveWei documentation ═════════════════════════════

    function test_C9_GasReserveWeiStoredButNotEnforced() public {
        vm.prank(owner);
        vault.setGasReserveWei(1 ether);
        assertEq(vault.gasReserveWei(), 1 ether, "stored");
        // No enforcement — execute() does not check gasReserveWei
    }

    // ═══ Execute with declared tokens ═════════════════════════════════

    function test_ExecuteWithDeclaredTokensRoutesOutputProfit() public {
        // Don't register tokenB — use declared tokens
        address[] memory declaredTokens = new address[](1);
        declaredTokens[0] = address(tokenB);

        bytes memory data = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), 300e18);
        vm.prank(operator);
        vault.executeWithDeclaredTokens(address(profitTarget), data, declaredTokens);

        assertEq(tokenB.balanceOf(profitRecipient), 300e18, "declared output token profit routed");
        assertEq(tokenB.balanceOf(address(vault)), 0, "vault retains 0 tokenB");
    }
}
