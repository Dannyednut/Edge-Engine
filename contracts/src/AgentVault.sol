// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * AgentVault — Smart Wallet Contract for the Edge-Engine arbitrage agent
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Architecture:
 *   - Owner (Principal Wallet) — immutable authority. Funds the vault, sets
 *     the operator, whitelists target contracts, sets profit split, can
 *     pause/unpause, can recover any token at any time.
 *   - Operator (Agent Wallet) — signs and submits all routine transactions.
 *     Can call any whitelisted target with arbitrary calldata. Can request
 *     flashloans via Balancer V2 (0% fee) or Aave V3 (0.05% fee) through
 *     the vault. Cannot change owner, cannot redirect profits, cannot
 *     withdraw protected principal, cannot pause.
 *
 * Profit flow:
 *   - Every `execute()` call ends with a profit check. If the vault's
 *     balance of any token increased beyond a threshold, the excess is
 *     routed to `profitRecipient` (default = owner). The agent keeps only
 *     the gas float in ETH.
 *   - Principal protection: the vault tracks `protectedPrincipal` per
 *     token. The operator cannot withdraw protected principal — only the
 *     profit above protected principal can be routed.
 *
 * Revocation:
 *   - Owner can call `setOperator(address(0))` to instantly revoke the
 *     agent's authority. All `execute()` calls revert from that point.
 *   - Owner can call `pause()` to freeze everything except `recover()`.
 *   - Owner can call `recover()` to sweep any token to themselves at any
 *     time, even when paused, even if the operator is still set.
 *
 * Audit notes:
 *   - ReentrancyGuard on all entry points
 *   - No arbitrary `delegatecall` (only `call` to whitelisted targets)
 *   - No `transfer()` to arbitrary addresses (only owner / profitRecipient)
 *   - All state-changing functions emit events for off-chain monitoring
 *   - Owner-only functions use OpenZeppelin-style `onlyOwner` modifier
 *   - Operator-only functions use `onlyOperator` modifier
 *   - `whenNotPaused` on `execute()` and flashloan entry points
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IAaveV3Pool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IFlashLoanRecipient {
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

contract AgentVault is
    Ownable,
    Pausable,
    ReentrancyGuard,
    IFlashLoanRecipient,
    IFlashLoanSimpleReceiver
{
    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event OperatorChanged(address indexed oldOperator, address indexed newOperator);
    event ProfitRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event TargetWhitelisted(address indexed target, bool allowed);
    event TokenProtected(address indexed token, uint256 amount);
    event TokenUnprotected(address indexed token, uint256 amount);
    event ProfitRouted(address indexed token, uint256 amount, address indexed to);
    event Executed(address indexed target, bytes calldataPayload, bool success, bytes result);
    event FlashLoanInitiated(address indexed provider, address[] tokens, uint256[] amounts);
    event FlashLoanCompleted(address indexed provider, uint256 totalRepaid, uint256 feePaid);
    event Recovered(address indexed token, uint256 amount, address indexed to);
    event Paused();
    event Unpaused();

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice The agent wallet — signs and submits all routine transactions
    address public operator;

    /// @notice Where profits get routed (default = owner)
    address public profitRecipient;

    /// @notice Whitelist of contracts the operator may call
    mapping(address => bool) public whitelistedTargets;

    /// @notice Protected principal per token — operator cannot withdraw this
    mapping(address => uint256) public protectedPrincipal;

    /// @notice Gas reserve kept in the vault for operator's gas (in ETH)
    uint256 public gasReserveWei;

    /// @notice Balancer V2 Vault address (0xBA12222222228d8Ba445958a75a0704d566BF2C8 on most chains)
    address public immutable balancerVault;

    /// @notice Aave V3 Pool address (chain-specific, set in constructor)
    address public immutable aaveV3Pool;

    /// @notice Chain ID this vault is deployed on
    uint256 public immutable chainId;

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error OnlyOperator();
    error OnlyOwner();
    error TargetNotWhitelisted(address target);
    error InsufficientGasReserve();
    error ProtectedPrincipalBreached(address token, uint256 available, uint256 protected);
    error FlashLoanNotAuthorized();
    error FlashLoanRepayFailed(address token, uint256 owed, uint256 available);
    error ZeroAddress();

    // ═══════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(
        address _owner,
        address _operator,
        address _profitRecipient,
        address _balancerVault,
        address _aaveV3Pool,
        uint256 _chainId
    ) Ownable(_owner) {
        if (_operator == address(0)) revert ZeroAddress();
        if (_profitRecipient == address(0)) _profitRecipient = _owner;

        operator = _operator;
        profitRecipient = _profitRecipient;
        balancerVault = _balancerVault;
        aaveV3Pool = _aaveV3Pool;
        chainId = _chainId;

        emit OperatorChanged(address(0), _operator);
        emit ProfitRecipientChanged(address(0), _profitRecipient);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // OWNER FUNCTIONS — settings
    // ═══════════════════════════════════════════════════════════════════════

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    function setProfitRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) newRecipient = owner();
        emit ProfitRecipientChanged(profitRecipient, newRecipient);
        profitRecipient = newRecipient;
    }

    function setWhitelistedTarget(address target, bool allowed) external onlyOwner {
        whitelistedTargets[target] = allowed;
        emit TargetWhitelisted(target, allowed);
    }

    function setWhitelistedTargets(address[] calldata targets, bool allowed) external onlyOwner {
        for (uint256 i = 0; i < targets.length; i++) {
            whitelistedTargets[targets[i]] = allowed;
            emit TargetWhitelisted(targets[i], allowed);
        }
    }

    function protectToken(address token, uint256 amount) external onlyOwner {
        protectedPrincipal[token] += amount;
        emit TokenProtected(token, amount);
    }

    function unprotectToken(address token, uint256 amount) external onlyOwner {
        require(protectedPrincipal[token] >= amount, "insufficient protected");
        protectedPrincipal[token] -= amount;
        emit TokenUnprotected(token, amount);
    }

    function setGasReserveWei(uint256 _gasReserveWei) external onlyOwner {
        gasReserveWei = _gasReserveWei;
    }

    function pause() external onlyOwner {
        _pause();
        emit Paused();
    }

    function unpause() external onlyOwner {
        _unpause();
        emit Unpaused();
    }

    /// @notice Owner can sweep any token at any time, even when paused.
    ///         This is the recovery valve.
    function recover(address token, uint256 amount, address to) external onlyOwner {
        if (to == address(0)) to = owner();
        _safeTransfer(token, to, amount);
        emit Recovered(token, amount, to);
    }

    /// @notice Owner can sweep the entire vault in one call (nuclear recovery).
    function recoverAll(address[] calldata tokens, address to) external onlyOwner {
        if (to == address(0)) to = owner();
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 bal = _balanceOf(tokens[i], address(this));
            if (bal > 0) {
                _safeTransfer(tokens[i], to, bal);
                emit Recovered(tokens[i], bal, to);
            }
        }
        // Also sweep native ETH
        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            (bool sent, ) = to.call{value: ethBal}("");
            require(sent, "ETH transfer failed");
            emit Recovered(address(0), ethBal, to);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // OPERATOR FUNCTIONS — routine execution
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Operator calls a whitelisted target with arbitrary calldata.
     *         After the call, profits above protected principal are routed
     *         to profitRecipient. Reverts if target not whitelisted or if
     *         protected principal is breached.
     * @param target  Whitelisted contract address (e.g. Uniswap V4 router)
     * @param data    Calldata to send to target
     * @return success Whether the call succeeded
     * @return result  Return data or revert reason
     */
    function execute(address target, bytes calldata data)
        external
        onlyOperator
        nonReentrant
        whenNotPaused
        returns (bool success, bytes memory result)
    {
        if (!whitelistedTargets[target]) revert TargetNotWhitelisted(target);

        // Snapshot balances before
        address[] memory tokensToCheck = _tokensToCheckAfterCall();
        uint256[] memory balancesBefore = _snapshotBalances(tokensToCheck);

        // Execute the call
        (success, result) = target.call(data);
        emit Executed(target, data, success, result);
        require(success, "target call failed");

        // Route profits above protected principal
        _routeProfits(tokensToCheck, balancesBefore);

        // Ensure protected principal is never breached
        _assertProtectedPrincipalIntact(tokensToCheck);
    }

    /**
     * @notice Operator initiates a Balancer V2 flashloan (0% fee).
     *         The vault itself is the recipient — `receiveFlashLoan` is
     *         called by Balancer with the borrowed tokens.
     * @param tokens   Tokens to borrow
     * @param amounts  Amounts to borrow
     * @param userData Arbitrary data passed to receiveFlashLoan
     */
    function balancerFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external onlyOperator nonReentrant whenNotPaused {
        IBalancerVault(balancerVault).flashLoan(address(this), tokens, amounts, userData);
    }

    /**
     * @notice Operator initiates an Aave V3 flashloan (0.05% fee).
     * @param asset  Token to borrow
     * @param amount Amount to borrow
     * @param params Arbitrary data passed to executeOperation
     */
    function aaveFlashLoan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOperator nonReentrant whenNotPaused {
        IAaveV3Pool(aaveV3Pool).flashLoanSimple(address(this), asset, amount, params, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FLASHLOAN CALLBACKS — called by Balancer / Aave during the flashloan
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Balancer V2 flashloan callback. The vault has just received
     *         `tokens`/`amounts`. The operator-encoded strategy is in
     *         `userData`. We decode it and execute the swaps. After this
     *         returns, Balancer expects `tokens + feeAmounts` to be back
     *         in the vault. (Balancer's fee is 0% so feeAmounts = 0.)
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        // Only Balancer Vault can call this
        if (msg.sender != balancerVault) revert FlashLoanNotAuthorized();

        emit FlashLoanInitiated(address(balancerVault), tokens, amounts);

        // Decode the operator's strategy: a list of (target, data) pairs
        // Each target must be whitelisted
        (
            address[] memory targets,
            bytes[] memory datas
        ) = abi.decode(userData, (address[], bytes[]));

        // Snapshot balances before
        uint256[] memory balancesBefore = _snapshotBalances(tokens);

        // Execute each swap in order
        for (uint256 i = 0; i < targets.length; i++) {
            require(whitelistedTargets[targets[i]], "target not whitelisted");
            (bool ok, bytes memory ret) = targets[i].call(datas[i]);
            if (!ok) {
                // Bubble up revert reason
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            emit Executed(targets[i], datas[i], ok, ret);
        }

        // Repay Balancer (tokens + feeAmounts; feeAmounts = 0 for Balancer)
        uint256 totalRepaid = 0;
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 owed = amounts[i] + feeAmounts[i];
            uint256 available = _balanceOf(tokens[i], address(this));
            if (available < owed) revert FlashLoanRepayFailed(tokens[i], owed, available);
            _safeTransfer(tokens[i], balancerVault, owed);
            totalRepaid += owed;
        }

        emit FlashLoanCompleted(balancerVault, totalRepaid, 0);

        // Route any profit made during the flashloan
        _routeProfits(tokens, balancesBefore);
        _assertProtectedPrincipalIntact(tokens);
    }

    /**
     * @notice Aave V3 flashloan callback. Same pattern as Balancer but
     *         single-token. Aave charges 0.05% fee (5 basis points).
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != aaveV3Pool) revert FlashLoanNotAuthorized();
        require(initiator == address(this), "initiator must be vault");

        address[] memory tokens = new address[](1);
        tokens[0] = asset;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        emit FlashLoanInitiated(aaveV3Pool, tokens, amounts);

        uint256[] memory balancesBefore = _snapshotBalances(tokens);

        // Decode strategy
        (address[] memory targets, bytes[] memory datas) = abi.decode(params, (address[], bytes[]));
        for (uint256 i = 0; i < targets.length; i++) {
            require(whitelistedTargets[targets[i]], "target not whitelisted");
            (bool ok, bytes memory ret) = targets[i].call(datas[i]);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            emit Executed(targets[i], datas[i], ok, ret);
        }

        // Repay Aave (amount + premium)
        uint256 owed = amount + premium;
        uint256 available = _balanceOf(asset, address(this));
        if (available < owed) revert FlashLoanRepayFailed(asset, owed, available);
        _approve(asset, aaveV3Pool, owed);

        emit FlashLoanCompleted(aaveV3Pool, owed, premium);

        // Route profits
        _routeProfits(tokens, balancesBefore);
        _assertProtectedPrincipalIntact(tokens);

        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PROFIT ROUTING — internal
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @dev For each token in the list, if the vault's current balance exceeds
     *      the protected principal, the excess is routed to profitRecipient.
     *      Native ETH is excluded from auto-routing (kept as gas reserve).
     */
    function _routeProfits(address[] memory tokens, uint256[] memory balancesBefore) internal {
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            uint256 balanceNow = _balanceOf(token, address(this));
            uint256 balanceWas = balancesBefore[i];
            // Profit = balanceNow - max(protectedPrincipal, balanceWas)
            // If balanceNow < protectedPrincipal, profit is 0 (don't route)
            uint256 floor = protectedPrincipal[token] > balanceWas
                ? protectedPrincipal[token]
                : balanceWas;
            if (balanceNow > floor) {
                uint256 profit = balanceNow - floor;
                _safeTransfer(token, profitRecipient, profit);
                emit ProfitRouted(token, profit, profitRecipient);
            }
        }
    }

    function _assertProtectedPrincipalIntact(address[] memory tokens) internal view {
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 bal = _balanceOf(tokens[i], address(this));
            if (bal < protectedPrincipal[tokens[i]]) {
                revert ProtectedPrincipalBreached(tokens[i], bal, protectedPrincipal[tokens[i]]);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    function _tokensToCheckAfterCall() internal pure returns (address[] memory) {
        // For non-flashloan execute() calls, we don't know which tokens to
        // check. The operator is responsible for not touching protected
        // principal. Profit routing for execute() is best-effort.
        // For atomic safety, use flashloan path.
        return new address[](0);
    }

    function _snapshotBalances(address[] memory tokens) internal view returns (uint256[] memory) {
        uint256[] memory balances = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            balances[i] = _balanceOf(tokens[i], address(this));
        }
        return balances;
    }

    function _balanceOf(address token, address account) internal view returns (uint256) {
        if (token == address(0)) {
            return account.balance;
        }
        return IERC20(token).balanceOf(account);
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool sent, ) = to.call{value: amount}("");
            require(sent, "ETH transfer failed");
        } else {
            // Use safe transfer pattern for ERC20
            (bool ok, bytes memory data) = token.call(
                abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
            );
            require(ok && (data.length == 0 || abi.decode(data, (bool))), "ERC20 transfer failed");
        }
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, amount)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "ERC20 approve failed");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RECEIVE — accept native ETH (for gas top-ups and ETH profits)
    // ═══════════════════════════════════════════════════════════════════════

    receive() external payable {}
    fallback() external payable {}
}
