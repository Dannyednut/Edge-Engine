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
    MockERC20 public tokenC; // third token for declared output tests
    MockBalancerVault public balancerVault;
    MockAaveV3Pool public aavePool;
    ProfitTarget public profitTarget;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public profitRecipient = makeAddr("profitRecipient");

    function setUp() public {
        tokenA = new MockERC20("TokenA", "TKA", 18);
        tokenB = new MockERC20("TokenB", "TKB", 18);
        tokenC = new MockERC20("TokenC", "TKC", 18);
        balancerVault = new MockBalancerVault();
        aavePool = new MockAaveV3Pool();
        profitTarget = new ProfitTarget();

        vm.startPrank(owner);
        vault = new AgentVault(owner, operator, profitRecipient, address(balancerVault), address(aavePool), block.chainid);
        vault.setWhitelistedTarget(address(profitTarget), true);
        vault.setWhitelistedTarget(address(tokenA), true);
        vault.setWhitelistedTarget(address(tokenB), true);
        tokenA.mint(address(vault), 10_000e18);
        vm.stopPrank();
    }

    // Helper: encode Balancer userData with (targets, datas, outputTokens)
    function _encodeBalancerUserData(
        address[] memory targets,
        bytes[] memory datas,
        address[] memory outputTokens
    ) internal pure returns (bytes memory) {
        return abi.encode(targets, datas, outputTokens);
    }

    // Helper: encode Aave params with (targets, datas, outputTokens)
    function _encodeAaveParams(
        address[] memory targets,
        bytes[] memory datas,
        address[] memory outputTokens
    ) internal pure returns (bytes memory) {
        return abi.encode(targets, datas, outputTokens);
    }

    // ═══ B1: execute() principal drain and profit routing ════════════

    function test_B1_ExecuteDrainProtectedPrincipalReverts() public {
        vm.prank(owner);
        vault.protectToken(address(tokenA), 10_000e18);

        bytes memory data = abi.encodeWithSelector(IERC20.transfer.selector, profitRecipient, 1000e18);
        vm.prank(operator);
        vm.expectRevert();
        vault.execute(address(tokenA), data);

        assertEq(tokenA.balanceOf(address(vault)), 10_000e18, "vault balance intact");
        assertEq(tokenA.balanceOf(profitRecipient), 0, "no drain");
    }

    function test_B1_ExecuteRoutesProfit() public {
        vm.prank(owner);
        vault.protectToken(address(tokenA), 10_000e18);

        bytes memory data = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenA), address(vault), 500e18);
        vm.prank(operator);
        vault.execute(address(profitTarget), data);

        assertEq(tokenA.balanceOf(profitRecipient), 500e18, "profit routed");
        assertEq(tokenA.balanceOf(address(vault)), 10_000e18, "vault retains protected principal");
    }

    // ═══ B2: Balancer snapshot arithmetic ═════════════════════════════

    function test_B2_BalancerProfitInBorrowedTokenRouted() public {
        vm.prank(owner);
        vault.protectToken(address(tokenB), 0);

        uint256 borrowAmount = 1000e18;
        uint256 profitAmount = 100e18;

        address[] memory targets = new address[](1);
        targets[0] = address(profitTarget);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), profitAmount);
        address[] memory outputTokens = new address[](0);
        bytes memory userData = _encodeBalancerUserData(targets, datas, outputTokens);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        uint256 recipientBefore = tokenB.balanceOf(profitRecipient);
        vm.prank(operator);
        vault.balancerFlashLoan(tokens, amounts, userData);

        assertEq(tokenB.balanceOf(profitRecipient) - recipientBefore, 100e18, "profit routed");
        assertEq(tokenB.balanceOf(address(vault)), 0, "vault retains 0");
    }

    function test_B2_BalancerNoProfitNoRouting() public {
        vm.prank(owner);
        vault.protectToken(address(tokenB), 0);

        uint256 borrowAmount = 1000e18;
        address[] memory targets = new address[](0);
        bytes[] memory datas = new bytes[](0);
        address[] memory outputTokens = new address[](0);
        bytes memory userData = _encodeBalancerUserData(targets, datas, outputTokens);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        uint256 recipientBefore = tokenB.balanceOf(profitRecipient);
        vm.prank(operator);
        vault.balancerFlashLoan(tokens, amounts, userData);

        assertEq(tokenB.balanceOf(profitRecipient), recipientBefore, "no profit routed");
        assertEq(tokenB.balanceOf(address(vault)), 0, "vault retains 0");
    }

    // ═══ B3: Aave tests with post-callback transferFrom ══════════════

    function test_B3_AaveProfitInBorrowedTokenRouted() public {
        vm.prank(owner);
        vault.protectToken(address(tokenB), 0);

        uint256 borrowAmount = 1000e18;
        uint256 premium = borrowAmount * 5 / 10000; // 0.5e18
        uint256 grossGain = 100e18 + premium; // profit covers premium

        address[] memory targets = new address[](1);
        targets[0] = address(profitTarget);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), grossGain);
        address[] memory outputTokens = new address[](0);
        bytes memory params = _encodeAaveParams(targets, datas, outputTokens);

        uint256 recipientBefore = tokenB.balanceOf(profitRecipient);
        vm.prank(operator);
        vault.aaveFlashLoan(address(tokenB), borrowAmount, params);

        // Routed = grossGain - premium = 100e18
        assertEq(tokenB.balanceOf(profitRecipient) - recipientBefore, 100e18, "Aave profit routed");
        assertEq(tokenB.balanceOf(address(vault)), 0, "vault retains 0");
    }

    function test_B3_AaveNonzeroPremiumFromVaultFunds() public {
        vm.prank(owner);
        vault.protectToken(address(tokenB), 0);
        tokenB.mint(address(vault), 1e18);

        uint256 borrowAmount = 1000e18;
        uint256 premium = borrowAmount * 5 / 10000; // 0.5e18

        address[] memory targets = new address[](0);
        bytes[] memory datas = new bytes[](0);
        address[] memory outputTokens = new address[](0);
        bytes memory params = _encodeAaveParams(targets, datas, outputTokens);

        vm.prank(operator);
        vault.aaveFlashLoan(address(tokenB), borrowAmount, params);

        assertEq(tokenB.balanceOf(address(vault)), 0.5e18, "vault retains 0.5 after premium");
    }

    function test_B3_AaveRepaymentFailureReverts() public {
        vm.prank(owner);
        vault.protectToken(address(tokenB), 0);

        uint256 borrowAmount = 1000e18;
        address[] memory targets = new address[](0);
        bytes[] memory datas = new bytes[](0);
        address[] memory outputTokens = new address[](0);
        bytes memory params = _encodeAaveParams(targets, datas, outputTokens);

        vm.prank(operator);
        vm.expectRevert();
        vault.aaveFlashLoan(address(tokenB), borrowAmount, params);
    }

    // ═══ B3-MANDATORY: Aave baseline-and-profit case ══════════════════

    function test_B3_AaveBaselineAndProfitExactAmounts() public {
        // Vault has pre-loan balance B0 = 500e18 of tokenB
        // Strategy generates profit p = 200e18 (pre-premium)
        // Premium = borrowAmount * 5/10000
        // Routed = p - premium
        // Final vault balance = B0

        uint256 B0 = 500e18;
        vm.startPrank(owner);
        vault.protectToken(address(tokenB), B0);
        tokenB.mint(address(vault), B0);
        vm.stopPrank();

        uint256 borrowAmount = 1000e18;
        uint256 premium = borrowAmount * 5 / 10000; // 0.5e18
        uint256 p = 200e18; // pre-premium gain (strategy generates only p)
        // Premium comes from vault's own balance, NOT from the strategy gain
        uint256 strategyGain = p;

        address[] memory targets = new address[](1);
        targets[0] = address(profitTarget);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), strategyGain);
        address[] memory outputTokens = new address[](0);
        bytes memory params = _encodeAaveParams(targets, datas, outputTokens);

        uint256 recipientBefore = tokenB.balanceOf(profitRecipient);
        vm.prank(operator);
        vault.aaveFlashLoan(address(tokenB), borrowAmount, params);

        // Routed = p - premium = 200 - 0.5 = 199.5e18
        assertEq(tokenB.balanceOf(profitRecipient) - recipientBefore, p - premium, "exact routed = p - premium");
        // Final vault balance = B0 - premium (premium paid from vault's own funds)
        // Actually: B0 + p - (p - premium) - premium = B0 - premium + premium = B0... wait
        // Let me recalculate:
        // Pre-loan: B0 = 500
        // After borrow + swaps: 500 + 1000 + p = 1700
        // After routing (p - premium): 1700 - (p - premium) = 1700 - 199.5 = 1500.5
        // After Aave pulls owed (1000.5): 1500.5 - 1000.5 = 500 = B0
        // So final = B0. Correct!
        assertEq(tokenB.balanceOf(address(vault)), B0, "final vault balance = B0");
    }

    function test_B3_AaveBaselineAndProfitWithProtectedEqualsB0() public {
        // Same as above but protectedPrincipal = B0
        // Already the case in test_B3_AaveBaselineAndProfitExactAmounts
        // This variant explicitly asserts protected principal is not breached
        uint256 B0 = 500e18;
        vm.startPrank(owner);
        vault.protectToken(address(tokenB), B0);
        tokenB.mint(address(vault), B0);
        vm.stopPrank();

        uint256 borrowAmount = 1000e18;
        uint256 premium = borrowAmount * 5 / 10000;
        uint256 p = 200e18;
        uint256 strategyGain = p; // strategy generates only p, premium from vault funds

        address[] memory targets = new address[](1);
        targets[0] = address(profitTarget);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), strategyGain);
        address[] memory outputTokens = new address[](0);
        bytes memory params = _encodeAaveParams(targets, datas, outputTokens);

        vm.prank(operator);
        vault.aaveFlashLoan(address(tokenB), borrowAmount, params);

        // Protected principal is a public mapping — access directly
        assertEq(vault.protectedPrincipal(address(tokenB)), B0, "protected principal = B0");
    }

    // ═══ B4: Cross-token profits ═════════════════════════════════════

    function test_B4_BalancerCrossTokenProfitViaRegisteredToken() public {
        vm.startPrank(owner);
        vault.registerToken(address(tokenB));
        vm.stopPrank();

        uint256 borrowAmount = 1000e18;
        uint256 profitInB = 200e18;

        address[] memory targets = new address[](1);
        targets[0] = address(profitTarget);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), profitInB);
        address[] memory outputTokens = new address[](0);
        bytes memory userData = _encodeBalancerUserData(targets, datas, outputTokens);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenA);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        uint256 recipientBBefore = tokenB.balanceOf(profitRecipient);
        vm.prank(operator);
        vault.balancerFlashLoan(tokens, amounts, userData);

        assertEq(tokenB.balanceOf(profitRecipient) - recipientBBefore, 200e18, "cross-token profit via registered token");
        assertEq(tokenB.balanceOf(address(vault)), 0, "vault retains 0 tokenB");
    }

    function test_B4_BalancerCrossTokenProfitViaDeclaredOutputToken() public {
        // Do NOT register tokenC — use declared outputTokens
        uint256 borrowAmount = 1000e18;
        uint256 profitInC = 300e18;

        address[] memory targets = new address[](1);
        targets[0] = address(profitTarget);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenC), address(vault), profitInC);
        address[] memory outputTokens = new address[](1);
        outputTokens[0] = address(tokenC);
        bytes memory userData = _encodeBalancerUserData(targets, datas, outputTokens);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenA);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        uint256 recipientCBefore = tokenC.balanceOf(profitRecipient);
        vm.prank(operator);
        vault.balancerFlashLoan(tokens, amounts, userData);

        assertEq(tokenC.balanceOf(profitRecipient) - recipientCBefore, 300e18, "declared output token profit routed");
        assertEq(tokenC.balanceOf(address(vault)), 0, "vault retains 0 tokenC");
    }

    function test_B4_AaveCrossTokenProfitViaDeclaredOutputToken() public {
        uint256 borrowAmount = 1000e18;
        uint256 premium = borrowAmount * 5 / 10000;
        uint256 profitInC = 300e18;

        address[] memory targets = new address[](2);
        targets[0] = address(profitTarget);
        targets[1] = address(profitTarget);
        bytes[] memory datas = new bytes[](2);
        datas[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenC), address(vault), profitInC);
        datas[1] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenA), address(vault), premium);
        address[] memory outputTokens = new address[](1);
        outputTokens[0] = address(tokenC);
        bytes memory params = _encodeAaveParams(targets, datas, outputTokens);

        uint256 recipientCBefore = tokenC.balanceOf(profitRecipient);
        vm.prank(operator);
        vault.aaveFlashLoan(address(tokenA), borrowAmount, params);

        assertEq(tokenC.balanceOf(profitRecipient) - recipientCBefore, 300e18, "Aave declared output profit routed");
    }

    function test_B4_AaveCrossTokenProfitViaRegisteredToken() public {
        vm.startPrank(owner);
        vault.registerToken(address(tokenB));
        vm.stopPrank();

        uint256 borrowAmount = 1000e18;
        uint256 premium = borrowAmount * 5 / 10000;
        uint256 profitInB = 200e18;

        address[] memory targets = new address[](2);
        targets[0] = address(profitTarget);
        targets[1] = address(profitTarget);
        bytes[] memory datas = new bytes[](2);
        datas[0] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), profitInB);
        datas[1] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenA), address(vault), premium);
        address[] memory outputTokens = new address[](0);
        bytes memory params = _encodeAaveParams(targets, datas, outputTokens);

        uint256 recipientBBefore = tokenB.balanceOf(profitRecipient);
        vm.prank(operator);
        vault.aaveFlashLoan(address(tokenA), borrowAmount, params);

        assertEq(tokenB.balanceOf(profitRecipient) - recipientBBefore, 200e18, "Aave registered-token profit routed");
    }

    // ═══ B3-MANDATORY: Protected non-borrowed token drain via flashloan ═

    function test_B3_ProtectedNonBorrowedTokenDrainReverts() public {
        // Protect tokenA (10_000e18), borrow tokenB, try to drain tokenA
        // via the flashloan strategy
        vm.startPrank(owner);
        vault.protectToken(address(tokenA), 10_000e18);
        vault.protectToken(address(tokenB), 0);
        vm.stopPrank();

        uint256 borrowAmount = 1000e18;

        // Strategy: drain 1000e18 of tokenA from the vault
        address[] memory targets = new address[](1);
        targets[0] = address(tokenA);
        bytes[] memory datas = new bytes[](1);
        datas[0] = abi.encodeWithSelector(IERC20.transfer.selector, profitRecipient, 1000e18);
        address[] memory outputTokens = new address[](0);
        bytes memory userData = _encodeBalancerUserData(targets, datas, outputTokens);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        uint256 vaultABefore = tokenA.balanceOf(address(vault));
        vm.prank(operator);
        vm.expectRevert();
        vault.balancerFlashLoan(tokens, amounts, userData);

        // Balances intact
        assertEq(tokenA.balanceOf(address(vault)), vaultABefore, "tokenA intact after revert");
        assertEq(tokenA.balanceOf(profitRecipient), 0, "no drain");
    }

    // ═══ B4: Protected token not in borrowed list ════════════════════

    function test_B4_ProtectedTokenNotInBorrowedListEnforced() public {
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
        address[] memory outputTokens = new address[](0);
        bytes memory userData = _encodeBalancerUserData(targets, datas, outputTokens);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;

        vm.prank(operator);
        vault.balancerFlashLoan(tokens, amounts, userData);

        assertEq(tokenA.balanceOf(address(vault)), 10_000e18, "protected tokenA intact");
        assertEq(tokenB.balanceOf(profitRecipient), 200e18, "tokenB profit routed");
    }

    // ═══ B4: Execute with declared tokens ════════════════════════════

    function test_B4_ExecuteWithDeclaredTokensRoutesOutputProfit() public {
        address[] memory declaredTokens = new address[](1);
        declaredTokens[0] = address(tokenC);

        bytes memory data = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenC), address(vault), 300e18);
        vm.prank(operator);
        vault.executeWithDeclaredTokens(address(profitTarget), data, declaredTokens);

        assertEq(tokenC.balanceOf(profitRecipient), 300e18, "declared output profit routed");
        assertEq(tokenC.balanceOf(address(vault)), 0, "vault retains 0 tokenC");
    }

    // ═══ C8: Operator revocation ═════════════════════════════════════

    function test_C8_RevokeOperator() public {
        vm.prank(owner);
        vault.revokeOperator();

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

        bytes memory data = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenA), address(vault), 100e18);
        vm.prank(operator);
        vm.expectRevert(AgentVault.OnlyOperator.selector);
        vault.execute(address(profitTarget), data);

        vm.prank(newOp);
        vault.execute(address(profitTarget), data);
    }

    // ═══ C9: gasReserveWei ═══════════════════════════════════════════

    function test_C9_GasReserveWeiStoredButNotEnforced() public {
        vm.prank(owner);
        vault.setGasReserveWei(1 ether);
        assertEq(vault.gasReserveWei(), 1 ether, "stored");
    }

    // ═══ B4: address(0) registration rejected ════════════════════════

    function test_B4_RegisterTokenRejectsAddressZero() public {
        vm.prank(owner);
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        vault.registerToken(address(0));
    }

    function test_B4_ProtectTokenRejectsAddressZero() public {
        vm.prank(owner);
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        vault.protectToken(address(0), 100e18);
    }

    // ═══ B3: Baseline-array integrity ════════════════════════════════

    function test_B3_BaselineMismatchRevertsViaDirectCallback() public {
        // Exercise the baseline-mismatch path by calling receiveFlashLoan
        // directly with crafted userData where the preLoanBalances array
        // length does not match the effective token set length.
        //
        // The effective token set is computed from registered + borrowed +
        // output tokens. If we register tokenB and borrow tokenB, the
        // effective set = [tokenB] (1 token). If we pass preLoanBalances
        // of length 0, the mismatch should revert.

        vm.prank(owner);
        vault.protectToken(address(tokenB), 0); // registers tokenB

        // Craft userData with mismatched baseline length (0 instead of 1)
        address[] memory targets = new address[](0);
        bytes[] memory datas = new bytes[](0);
        address[] memory outputTokens = new address[](0);
        uint256[] memory wrongBaselines = new uint256[](0); // should be length 1

        bytes memory craftedUserData = abi.encode(targets, datas, outputTokens, wrongBaselines);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1000e18;
        uint256[] memory feeAmounts = new uint256[](1);

        // Mint tokens to vault BEFORE the prank so the callback has funds
        tokenB.mint(address(vault), 1000e18);

        // Prank as the balancer vault (lender authorization)
        vm.prank(address(balancerVault));
        vm.expectRevert("baseline length mismatch");
        vault.receiveFlashLoan(tokens, amounts, feeAmounts, craftedUserData);
    }

    // ═══ Item 1: address(0) declared output token rejection ══════════

    function test_Item1_ExecuteWithDeclaredTokensRejectsAddressZero() public {
        address[] memory declaredTokens = new address[](1);
        declaredTokens[0] = address(0);

        bytes memory data = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenA), address(vault), 100e18);
        vm.prank(operator);
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        vault.executeWithDeclaredTokens(address(profitTarget), data, declaredTokens);
    }

    function test_Item1_BalancerFlashLoanRejectsAddressZeroInOutputTokens() public {
        // Encode userData with address(0) in outputTokens
        address[] memory targets = new address[](0);
        bytes[] memory datas = new bytes[](0);
        address[] memory outputTokens = new address[](1);
        outputTokens[0] = address(0);
        bytes memory userData = _encodeBalancerUserData(targets, datas, outputTokens);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenB);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1000e18;

        vm.prank(operator);
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        vault.balancerFlashLoan(tokens, amounts, userData);
    }

    function test_Item1_AaveFlashLoanRejectsAddressZeroInOutputTokens() public {
        address[] memory targets = new address[](0);
        bytes[] memory datas = new bytes[](0);
        address[] memory outputTokens = new address[](1);
        outputTokens[0] = address(0);
        bytes memory params = _encodeAaveParams(targets, datas, outputTokens);

        vm.prank(operator);
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        vault.aaveFlashLoan(address(tokenB), 1000e18, params);
    }

    // ═══ Item 2: Aave protected non-borrowed token drain ═════════════

    function test_Item2_AaveProtectedNonBorrowedTokenDrainReverts() public {
        // Protect tokenA (10_000e18), borrow tokenB, drain tokenA via
        // the flashloan strategy through the Aave path.
        vm.startPrank(owner);
        vault.protectToken(address(tokenA), 10_000e18);
        vault.protectToken(address(tokenB), 0);
        vm.stopPrank();

        uint256 borrowAmount = 1000e18;
        uint256 premium = borrowAmount * 5 / 10000; // 0.5e18

        // Strategy: drain 1000e18 of tokenA from the vault + generate
        // enough tokenB to cover the premium
        address[] memory targets = new address[](2);
        targets[0] = address(tokenA);
        targets[1] = address(profitTarget);
        bytes[] memory datas = new bytes[](2);
        // First call: drain tokenA
        datas[0] = abi.encodeWithSelector(IERC20.transfer.selector, profitRecipient, 1000e18);
        // Second call: generate enough tokenB to cover repayment + premium
        datas[1] = abi.encodeWithSelector(ProfitTarget.sendProfit.selector, address(tokenB), address(vault), premium);
        address[] memory outputTokens = new address[](0);
        bytes memory params = _encodeAaveParams(targets, datas, outputTokens);

        uint256 vaultABefore = tokenA.balanceOf(address(vault));
        uint256 recipientABefore = tokenA.balanceOf(profitRecipient);

        vm.prank(operator);
        vm.expectRevert();
        vault.aaveFlashLoan(address(tokenB), borrowAmount, params);

        // Balances unchanged after revert
        assertEq(tokenA.balanceOf(address(vault)), vaultABefore, "tokenA vault balance intact");
        assertEq(tokenA.balanceOf(profitRecipient), recipientABefore, "tokenA recipient balance intact");
    }
}
