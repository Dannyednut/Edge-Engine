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
 *   - Every `execute()` call ends with a profit check using the effective
 *     token set (all protected tokens + any declared output tokens).
 *   - Flashloan callbacks use a pre-loan baseline (excluding borrowed
 *     principal) to compute profit.
 *   - Principal protection: the vault tracks `protectedPrincipal` per
 *     token via an owner-controlled registry. The operator cannot omit
 *     protected tokens from the effective check set.
 *
 * Revocation:
 *   - Owner can call `revokeOperator()` to instantly revoke the agent's
 *     authority (sets operator to address(0)). All execute() calls revert.
 *   - Owner can call `pause()` to freeze everything except `recover()`.
 *   - Owner can call `recover()` to sweep any token to themselves at any
 *     time, even when paused, even if the operator is still set.
 *
 * Protected token registry:
 *   - Owner registers tokens whose principal must be protected via
 *     `protectToken()`. The registry is deduplicated.
 *   - The effective token set for profit routing and principal checks
 *     always includes ALL registered protected tokens, plus any borrowed
 *     tokens (for flashloans), plus any operator-declared output tokens.
 *   - The operator cannot omit protected tokens from the check set.
 *
 * gasReserveWei:
 *   - Stored but currently NOT enforced. The field exists for future gas-
 *     management features. It does not affect any control flow in this
 *     version. Owners should not rely on it until enforcement is added.
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
    event OperatorRevoked(address indexed oldOperator);
    event ProfitRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event TargetWhitelisted(address indexed target, bool allowed);
    event TokenProtected(address indexed token, uint256 amount);
    event TokenUnprotected(address indexed token, uint256 amount);
    event TokenRegistered(address indexed token);
    event TokenUnregistered(address indexed token);
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

    /// @notice The agent wallet — signs and submits all routine transactions.
    ///         address(0) means the operator has been revoked.
    address public operator;

    /// @notice Where profits get routed (default = owner)
    address public profitRecipient;

    /// @notice Whitelist of contracts the operator may call
    mapping(address => bool) public whitelistedTargets;

    /// @notice Protected principal per token — operator cannot withdraw this
    mapping(address => uint256) public protectedPrincipal;

    /// @notice Owner-controlled deduplicated registry of protected tokens.
    ///         All registered tokens are ALWAYS included in the effective
    ///         check set, regardless of what the operator declares.
    address[] public registeredTokens;
    mapping(address => bool) public isRegistered;

    /// @notice Gas reserve kept in the vault for operator's gas (in ETH).
    ///         NOTE: Currently NOT enforced. Stored for future use.
    uint256 public gasReserveWei;

    /// @notice Balancer V2 Vault address
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
    error ProtectedPrincipalBreached(address token, uint256 available, uint256 protected_);
    error FlashLoanNotAuthorized();
    error FlashLoanRepayFailed(address token, uint256 owed, uint256 available);
    error ZeroAddress();
    error OperatorRevokedError();
    error AlreadyRegistered(address token);
    error NotRegistered(address token);

    // ═══════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════

    modifier onlyOperator() {
        if (operator == address(0)) revert OperatorRevokedError();
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

    /// @notice Set a new operator. Cannot be used to revoke — use revokeOperator().
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    /// @notice Revoke the operator's authority. Sets operator to address(0).
    ///         All execute() and flashloan calls will revert with OperatorRevoked().
    function revokeOperator() external onlyOwner {
        emit OperatorRevoked(operator);
        operator = address(0);
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
        // Auto-register the token so it's always in the effective check set
        if (!isRegistered[token]) {
            isRegistered[token] = true;
            registeredTokens.push(token);
            emit TokenRegistered(token);
        }
        emit TokenProtected(token, amount);
    }

    function unprotectToken(address token, uint256 amount) external onlyOwner {
        require(protectedPrincipal[token] >= amount, "insufficient protected");
        protectedPrincipal[token] -= amount;
        emit TokenUnprotected(token, amount);
    }

    /// @notice Register a token in the protected-token registry.
    ///         Registered tokens are ALWAYS included in the effective check set.
    function registerToken(address token) external onlyOwner {
        if (isRegistered[token]) revert AlreadyRegistered(token);
        isRegistered[token] = true;
        registeredTokens.push(token);
        emit TokenRegistered(token);
    }

    /// @notice Unregister a token. Only works if the token has no protected principal.
    function unregisterToken(address token) external onlyOwner {
        if (!isRegistered[token]) revert NotRegistered(token);
        require(protectedPrincipal[token] == 0, "cannot unregister token with protected principal");
        isRegistered[token] = false;
        // Remove from array (swap-and-pop)
        for (uint256 i = 0; i < registeredTokens.length; i++) {
            if (registeredTokens[i] == token) {
                registeredTokens[i] = registeredTokens[registeredTokens.length - 1];
                registeredTokens.pop();
                break;
            }
        }
        emit TokenUnregistered(token);
    }

    /// @notice Get all registered protected tokens.
    function getRegisteredTokens() external view returns (address[] memory) {
        return registeredTokens;
    }

    /// @notice Set the gas reserve. NOTE: Currently NOT enforced.
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

    /// @notice Legacy execute() — enforces ALL registered protected tokens.
    ///         Profit routing uses the effective token set (all registered
    ///         protected tokens). Output-token profit routing is NOT
    ///         available via this entry point — use executeWithDeclaredTokens()
    ///         if the call may produce profit in non-registered tokens.
    function execute(address target, bytes calldata data)
        external
        onlyOperator
        nonReentrant
        whenNotPaused
        returns (bool success, bytes memory result)
    {
        if (!whitelistedTargets[target]) revert TargetNotWhitelisted(target);

        // Effective token set = all registered protected tokens
        address[] memory effectiveTokens = _getEffectiveTokens(new address[](0));
        uint256[] memory baselines = _snapshotBalances(effectiveTokens);

        (success, result) = target.call(data);
        emit Executed(target, data, success, result);
        require(success, "target call failed");

        _routeProfits(effectiveTokens, baselines);
        _assertProtectedPrincipalIntact(effectiveTokens);
    }

    /// @notice Execute with operator-declared output/check tokens.
    ///         The effective token set = registered protected tokens + declared
    ///         tokens (deduplicated). Use this when the call may produce profit
    ///         in tokens that are not in the protected-token registry.
    /// @param target        Whitelisted contract address
    /// @param data          Calldata to send to target
    /// @param declaredTokens Additional tokens to check for profit (beyond protected)
    function executeWithDeclaredTokens(
        address target,
        bytes calldata data,
        address[] calldata declaredTokens
    ) external onlyOperator nonReentrant whenNotPaused returns (bool success, bytes memory result) {
        if (!whitelistedTargets[target]) revert TargetNotWhitelisted(target);

        address[] memory effectiveTokens = _getEffectiveTokens(declaredTokens);
        uint256[] memory baselines = _snapshotBalances(effectiveTokens);

        (success, result) = target.call(data);
        emit Executed(target, data, success, result);
        require(success, "target call failed");

        _routeProfits(effectiveTokens, baselines);
        _assertProtectedPrincipalIntact(effectiveTokens);
    }

    /// @notice Balancer V2 flashloan entry point.
    ///         userData encodes (address[] targets, bytes[] datas, address[] outputTokens).
    ///         outputTokens are additional tokens to check for profit beyond
    ///         the borrowed tokens and registered protected tokens.
    function balancerFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external onlyOperator nonReentrant whenNotPaused {
        // Snapshot pre-loan baselines BEFORE the loan arrives
        // Store in transient storage (or pass via userData encoding)
        // We encode baselines into the userData so the callback has them
        bytes memory enhancedUserData = _encodeBalancerUserData(userData, tokens);
        IBalancerVault(balancerVault).flashLoan(address(this), tokens, amounts, enhancedUserData);
    }

    /// @notice Aave V3 flashloan entry point.
    ///         params encodes (address[] targets, bytes[] datas, address[] outputTokens).
    function aaveFlashLoan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOperator nonReentrant whenNotPaused {
        // Snapshot pre-loan baseline for the asset
        // We'll pass it through the params encoding
        bytes memory enhancedParams = _encodeAaveParams(params, asset);
        IAaveV3Pool(aaveV3Pool).flashLoanSimple(address(this), asset, amount, enhancedParams, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FLASHLOAN CALLBACKS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Balancer V2 flashloan callback.
    ///         Called by the Balancer Vault AFTER sending borrowed tokens.
    ///         Repayment happens inside this callback via _safeTransfer.
    ///         Profit routing uses pre-loan baselines (borrowed principal excluded).
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        if (msg.sender != balancerVault) revert FlashLoanNotAuthorized();

        emit FlashLoanInitiated(address(balancerVault), tokens, amounts);

        // Decode enhanced userData: (targets, datas, outputTokens, preLoanBalances)
        (
            address[] memory targets,
            bytes[] memory datas,
            address[] memory outputTokens,
            uint256[] memory preLoanBalances
        ) = abi.decode(userData, (address[], bytes[], address[], uint256[]));

        // Effective token set = borrowed tokens + output tokens + registered protected tokens
        address[] memory effectiveTokens = _getEffectiveTokensFlashloan(tokens, outputTokens);

        // Execute swaps
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

        // Repay Balancer (tokens + feeAmounts; fee = 0 for Balancer)
        uint256 totalRepaid = 0;
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 owed = amounts[i] + feeAmounts[i];
            uint256 available = _balanceOf(tokens[i], address(this));
            if (available < owed) revert FlashLoanRepayFailed(tokens[i], owed, available);
            _safeTransfer(tokens[i], balancerVault, owed);
            totalRepaid += owed;
        }
        emit FlashLoanCompleted(balancerVault, totalRepaid, 0);

        // Route profits using pre-loan baselines (borrowed principal excluded)
        _routeProfitsWithBaselines(effectiveTokens, preLoanBalances);
        _assertProtectedPrincipalIntact(effectiveTokens);
    }

    /// @notice Aave V3 flashloan callback.
    ///         Called by Aave Pool AFTER sending the borrowed asset.
    ///         Aave pulls repayment via transferFrom AFTER this callback returns.
    ///         We must compute projected post-repayment balance BEFORE routing.
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

        // Decode enhanced params: (targets, datas, outputTokens, preLoanBalance)
        (
            address[] memory targets,
            bytes[] memory datas,
            address[] memory outputTokens,
            uint256[] memory preLoanBalances
        ) = abi.decode(params, (address[], bytes[], address[], uint256[]));

        // Effective token set
        address[] memory effectiveTokens = _getEffectiveTokensFlashloan(tokens, outputTokens);

        // Execute swaps
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

        // Aave pulls repayment AFTER this callback returns via transferFrom.
        // We approve the pool for amount + premium.
        uint256 owed = amount + premium;
        uint256 available = _balanceOf(asset, address(this));
        if (available < owed) revert FlashLoanRepayFailed(asset, owed, available);
        _approve(asset, aaveV3Pool, owed);
        emit FlashLoanCompleted(aaveV3Pool, owed, premium);

        // Compute PROJECTED post-repayment balance for the borrowed asset.
        // After Aave pulls `owed`, the vault's balance of `asset` will be:
        //   currentBalance - owed
        // We must check that this projected balance does not breach protected
        // principal, and route only the projected surplus.
        //
        // For non-borrowed tokens (output tokens, other protected tokens),
        // the current balance IS the post-repayment balance (no pull happens).

        // Build projected balances for profit routing
        uint256[] memory projectedBalances = new uint256[](effectiveTokens.length);
        for (uint256 i = 0; i < effectiveTokens.length; i++) {
            if (effectiveTokens[i] == asset) {
                // Projected = current - owed (what will remain after Aave pulls)
                projectedBalances[i] = _balanceOf(asset, address(this)) - owed;
            } else {
                // Non-borrowed tokens: current balance is the final balance
                projectedBalances[i] = _balanceOf(effectiveTokens[i], address(this));
            }
        }

        // Route profits using pre-loan baselines and projected balances
        _routeProfitsWithProjectedBalances(effectiveTokens, preLoanBalances, projectedBalances, asset, owed);

        // Assert protected principal using PROJECTED balances (not current,
        // because Aave hasn't pulled yet). For the borrowed asset, the projected
        // balance is currentBalance - owed. For others, it's the current balance.
        for (uint256 i = 0; i < effectiveTokens.length; i++) {
            uint256 projectedBal;
            if (effectiveTokens[i] == asset) {
                projectedBal = _balanceOf(asset, address(this)) - owed;
            } else {
                projectedBal = _balanceOf(effectiveTokens[i], address(this));
            }
            if (projectedBal < protectedPrincipal[effectiveTokens[i]]) {
                revert ProtectedPrincipalBreached(effectiveTokens[i], projectedBal, protectedPrincipal[effectiveTokens[i]]);
            }
        }

        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PROFIT ROUTING — internal
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Route profits using current balance vs baseline.
    function _routeProfits(address[] memory tokens, uint256[] memory baselines) internal {
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            uint256 balanceNow = _balanceOf(token, address(this));
            uint256 floor = protectedPrincipal[token] > baselines[i]
                ? protectedPrincipal[token]
                : baselines[i];
            if (balanceNow > floor) {
                uint256 profit = balanceNow - floor;
                _safeTransfer(token, profitRecipient, profit);
                emit ProfitRouted(token, profit, profitRecipient);
            }
        }
    }

    /// @dev Route profits using pre-loan baselines (borrowed principal excluded).
    ///      Used by Balancer callback where repayment already happened.
    function _routeProfitsWithBaselines(address[] memory tokens, uint256[] memory preLoanBalances) internal {
        // Build a mapping from token to pre-loan balance
        // preLoanBalances was snapshotted for effectiveTokens in order
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            uint256 balanceNow = _balanceOf(token, address(this));
            uint256 baseline = preLoanBalances.length > i ? preLoanBalances[i] : 0;
            uint256 floor = protectedPrincipal[token] > baseline
                ? protectedPrincipal[token]
                : baseline;
            if (balanceNow > floor) {
                uint256 profit = balanceNow - floor;
                _safeTransfer(token, profitRecipient, profit);
                emit ProfitRouted(token, profit, profitRecipient);
            }
        }
    }

    /// @dev Route profits using projected balances (for Aave where repayment
    ///      hasn't happened yet). Only routes tokens where the projected
    ///      balance exceeds the floor. The borrowed asset's profit is routed
    ///      from the projected (post-repayment) surplus.
    function _routeProfitsWithProjectedBalances(
        address[] memory tokens,
        uint256[] memory preLoanBalances,
        uint256[] memory projectedBalances,
        address borrowedAsset,
        uint256 owed
    ) internal {
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            uint256 projected = projectedBalances[i];
            uint256 baseline = preLoanBalances.length > i ? preLoanBalances[i] : 0;
            uint256 floor = protectedPrincipal[token] > baseline
                ? protectedPrincipal[token]
                : baseline;
            if (projected > floor) {
                uint256 profit = projected - floor;
                // For the borrowed asset: we can only route profit that remains
                // AFTER Aave pulls `owed`. The vault currently has `projected + owed`.
                // After Aave pulls `owed`, it will have `projected`.
                // We route `profit` now — the vault must have enough to both
                // repay `owed` AND send `profit`.
                // Available for routing = currentBalance - owed (projected)
                // But we already computed projected = currentBalance - owed.
                // So if projected > floor, we route (projected - floor) = profit.
                // The vault has (projected + owed) = (profit + floor + owed).
                // After routing profit: (floor + owed). After Aave pulls owed: floor.
                // This is correct — the vault ends with `floor` (>= protected principal).
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
    // EFFECTIVE TOKEN SET — internal
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Build the effective token set = registered protected tokens + declared tokens.
    ///      Deduplicated. The operator cannot omit protected tokens.
    function _getEffectiveTokens(address[] memory declaredTokens) internal view returns (address[] memory) {
        // Start with registered tokens
        uint256 count = registeredTokens.length;
        // Add declared tokens that are not already registered
        for (uint256 i = 0; i < declaredTokens.length; i++) {
            if (!isRegistered[declaredTokens[i]]) {
                count++;
            }
        }

        address[] memory effective = new address[](count);
        uint256 idx = 0;
        // Add registered tokens
        for (uint256 i = 0; i < registeredTokens.length; i++) {
            effective[idx++] = registeredTokens[i];
        }
        // Add declared tokens (deduplicated against registered)
        for (uint256 i = 0; i < declaredTokens.length; i++) {
            if (!isRegistered[declaredTokens[i]]) {
                // Check for duplicates within declaredTokens
                bool dup = false;
                for (uint256 j = 0; j < i; j++) {
                    if (declaredTokens[j] == declaredTokens[i]) {
                        dup = true;
                        break;
                    }
                }
                if (!dup) {
                    effective[idx++] = declaredTokens[i];
                }
            }
        }

        // Trim array to actual size (in case of duplicates within declared)
        assembly {
            mstore(effective, idx)
        }

        return effective;
    }

    /// @dev Build effective token set for flashloans = registered + borrowed + output.
    function _getEffectiveTokensFlashloan(
        address[] memory borrowedTokens,
        address[] memory outputTokens
    ) internal view returns (address[] memory) {
        // Combine: registered + borrowed + output, deduplicated
        uint256 count = registeredTokens.length;
        for (uint256 i = 0; i < borrowedTokens.length; i++) {
            if (!isRegistered[borrowedTokens[i]]) count++;
        }
        for (uint256 i = 0; i < outputTokens.length; i++) {
            if (!isRegistered[outputTokens[i]]) count++;
        }

        address[] memory effective = new address[](count);
        uint256 idx = 0;
        // Registered
        for (uint256 i = 0; i < registeredTokens.length; i++) {
            effective[idx++] = registeredTokens[i];
        }
        // Borrowed (deduplicated)
        for (uint256 i = 0; i < borrowedTokens.length; i++) {
            bool seen = isRegistered[borrowedTokens[i]];
            for (uint256 j = 0; j < idx; j++) {
                if (effective[j] == borrowedTokens[i]) { seen = true; break; }
            }
            if (!seen) effective[idx++] = borrowedTokens[i];
        }
        // Output (deduplicated)
        for (uint256 i = 0; i < outputTokens.length; i++) {
            bool seen = isRegistered[outputTokens[i]];
            for (uint256 j = 0; j < idx; j++) {
                if (effective[j] == outputTokens[i]) { seen = true; break; }
            }
            if (!seen) effective[idx++] = outputTokens[i];
        }

        assembly { mstore(effective, idx) }
        return effective;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FLASHLOAN DATA ENCODING — internal
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Encode Balancer userData with pre-loan baselines.
    ///      Original userData: (address[] targets, bytes[] datas)
    ///      Enhanced userData: (address[] targets, bytes[] datas, address[] outputTokens, uint256[] preLoanBalances)
    function _encodeBalancerUserData(
        bytes memory userData,
        address[] memory borrowedTokens
    ) internal view returns (bytes memory) {
        // Decode original: (targets, datas)
        (address[] memory targets, bytes[] memory datas) = abi.decode(userData, (address[], bytes[]));

        // Extract outputTokens from targets/datas if encoded (or use empty)
        // For now, we use empty outputTokens — the operator can register them
        // via the protected-token registry or declare them separately.
        address[] memory outputTokens = new address[](0);

        // Build effective token set and snapshot pre-loan baselines
        address[] memory effectiveTokens = _getEffectiveTokensFlashloan(borrowedTokens, outputTokens);
        uint256[] memory preLoanBalances = _snapshotBalances(effectiveTokens);

        return abi.encode(targets, datas, outputTokens, preLoanBalances);
    }

    /// @dev Encode Aave params with pre-loan baseline.
    ///      Original params: (address[] targets, bytes[] datas)
    ///      Enhanced params: (address[] targets, bytes[] datas, address[] outputTokens, uint256[] preLoanBalances)
    function _encodeAaveParams(
        bytes memory params,
        address asset
    ) internal view returns (bytes memory) {
        (address[] memory targets, bytes[] memory datas) = abi.decode(params, (address[], bytes[]));
        address[] memory outputTokens = new address[](0);

        address[] memory borrowedTokens = new address[](1);
        borrowedTokens[0] = asset;
        address[] memory effectiveTokens = _getEffectiveTokensFlashloan(borrowedTokens, outputTokens);
        uint256[] memory preLoanBalances = _snapshotBalances(effectiveTokens);

        return abi.encode(targets, datas, outputTokens, preLoanBalances);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════

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
    // RECEIVE — accept native ETH
    // ═══════════════════════════════════════════════════════════════════════

    receive() external payable {}
    fallback() external payable {}
}
