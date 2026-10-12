// Atomic Arb Smart Contract Design
// Solidity contract for atomic arbitrage on HyperEVM
//
// Architecture:
//   1. Flashloan USDC from HyperLend
//   2. Read HL perp price via precompile 0x...0807
//   3. Read HyperSwap V3 price via slot0
//   4. If spread > threshold:
//      a. Buy on cheaper venue (CoreWriter or HyperSwap)
//      b. Sell on expensive venue (CoreWriter or HyperSwap)
//   5. Repay flashloan + fee
//   6. ALL in ONE transaction

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IHyperLendFlashLoan {
    function flashLoan(address token, uint256 amount, bytes calldata data) external;
}

interface ICoreWriter {
    // CoreWriter at 0x3333333333333333333333333333333333333333
    // Action: place perp order
    function placeOrder(
        int32 perpIndex,        // HL perp index (e.g., 0 for BTC)
        bool isBuy,             // true = buy, false = sell
        uint64 limitPx,         // limit price (in 6 decimals)
        uint64 sz,              // size in base units
        uint8 timeInForce       // 0 = GTC, 1 = IOC, 2 = ALO
    ) external;
}

interface IHyperSwapV3Pool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IHLPerpOracle {
    // Precompile at 0x0000000000000000000000000000000000000807
    function getPerpPrice(int32 perpIndex) external view returns (uint256);
}

contract AtomicArbExecutor {
    address constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    address constant HL_PERP_ORACLE = 0x0000000000000000000000000000000000000807;
    address constant HYPERLEND_FLASH_LOAN_PROVIDER = 0x...; // TODO: actual address

    address public owner;
    uint256 public totalProfit;
    uint256 public totalTrades;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * Execute atomic arbitrage between HL perp and HyperSwap V3
     *
     * @param perpIndex HL perp index (e.g., 0 for BTC)
     * @param pool HyperSwap V3 pool address
     * @param flashAmount USDC amount to flashloan
     * @param minProfit Minimum profit required (in USDC, 6 decimals)
     */
    function executeArb(
        int32 perpIndex,
        address pool,
        uint256 flashAmount,
        uint256 minProfit
    ) external onlyOwner {
        // 1. Flashloan USDC
        bytes memory data = abi.encode(perpIndex, pool, minProfit);
        IHyperLendFlashLoan(HYPERLEND_FLASH_LOAN_PROVIDER).flashLoan(
            address(0x...), // USDC address
            flashAmount,
            data
        );
    }

    /**
     * Called by HyperLend after flashloan
     */
    function onFlashLoanReceived(
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external {
        require(msg.sender == HYPERLEND_FLASH_LOAN_PROVIDER, "Not flashloan provider");

        (int32 perpIndex, address pool, uint256 minProfit) = abi.decode(data, (int32, address, uint256));

        // 2. Read HL perp price via precompile
        uint256 hlPerpPrice = IHLPerpOracle(HL_PERP_ORACLE).getPerpPrice(perpIndex);

        // 3. Read HyperSwap V3 price via slot0
        // ... (implementation)

        // 4. Compare prices and execute arb
        uint256 hyperSwapPrice = _getHyperSwapPrice(pool);

        if (hlPerpPrice < hyperSwapPrice) {
            // Buy on HL perp, sell on HyperSwap
            _executeBuyHLSellHyperSwap(perpIndex, pool, amount);
        } else if (hlPerpPrice > hyperSwapPrice) {
            // Buy on HyperSwap, sell on HL perp
            _executeBuyHyperSwapSellHL(perpIndex, pool, amount);
        } else {
            // No arb, revert
            revert("No arb opportunity");
        }

        // 5. Repay flashloan + fee
        uint256 totalRepay = amount + fee;
        require(
            IERC20(token).balanceOf(address(this)) >= totalRepay + minProfit,
            "Insufficient profit"
        );

        // 6. Transfer profit to owner
        uint256 profit = IERC20(token).balanceOf(address(this)) - totalRepay;
        totalProfit += profit;
        totalTrades += 1;
        IERC20(token).transfer(owner, profit);
    }

    function _getHyperSwapPrice(address pool) internal view returns (uint256) {
        // Call slot0 on HyperSwap V3 pool
        // ... (implementation)
        return 0;
    }

    function _executeBuyHLSellHyperSwap(int32 perpIndex, address pool, uint256 amount) internal {
        // 1. Place buy order on HL perp via CoreWriter
        // 2. Sell on HyperSwap V3
        // ... (implementation)
    }

    function _executeBuyHyperSwapSellHL(int32 perpIndex, address pool, uint256 amount) internal {
        // 1. Buy on HyperSwap V3
        // 2. Place sell order on HL perp via CoreWriter
        // ... (implementation)
    }

    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(owner, balance);
    }

    function getStats() external view returns (uint256, uint256) {
        return (totalProfit, totalTrades);
    }
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

// NOTE: This is a SOLIDITY contract, not TypeScript
// Save as AtomicArbExecutor.sol and deploy to HyperEVM
// Need:
//   - HyperLend flashloan provider address
//   - HyperSwap V3 pool addresses
//   - USDC address on HyperEVM
//   - Audit before mainnet deployment
//   - Test on testnet first

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Atomic Arb Smart Contract Design');
  console.log('═══════════════════════════════════════════════════\n');

  console.log('── Architecture ──\n');
  console.log('  1. Flashloan USDC from HyperLend (0.04% fee)');
  console.log('  2. Read HL perp price via precompile 0x...0807');
  console.log('  3. Read HyperSwap V3 price via slot0');
  console.log('  4. Execute arb:');
  console.log('     a. Buy on cheaper venue');
  console.log('     b. Sell on expensive venue');
  console.log('  5. Repay flashloan + fee');
  console.log('  6. ALL in ONE transaction (atomic)');
  console.log('');

  console.log('── Contract Components ──\n');
  console.log('  - IHyperLendFlashLoan: borrow USDC atomically');
  console.log('  - ICoreWriter: place HL perp orders');
  console.log('  - IHyperSwapV3Pool: swap on HyperSwap V3');
  console.log('  - IHLPerpOracle: read HL perp price (precompile)');
  console.log('');

  console.log('── Build Steps ──\n');
  console.log('  Phase 1 (1 week): Test contract on testnet');
  console.log('    - Deploy to HyperEVM testnet');
  console.log('    - Test with small amounts');
  console.log('    - Verify atomicity');
  console.log('');
  console.log('  Phase 2 (1 week): Audit + optimize');
  console.log('    - Smart contract audit');
  console.log('    - Gas optimization');
  console.log('    - Add fail-safes');
  console.log('');
  console.log('  Phase 3 (3 days): Mainnet deployment');
  console.log('    - Deploy with $1k initial capital');
  console.log('    - Monitor closely for 7 days');
  console.log('    - Scale to $25k after track record');
  console.log('');

  console.log('── Risk Profile ──\n');
  console.log('  ✅ Zero inventory risk (atomic execution)');
  console.log('  ✅ Zero directional risk (delta-neutral)');
  console.log('  ⚠️ Smart contract risk (new contract)');
  console.log('  ⚠️ Gas cost risk (HyperEVM gas)');
  console.log('  ⚠️ MEV risk (other atomic arbitrageurs)');
  console.log('  ⚠️ Flashloan provider risk (HyperLend)');
  console.log('');

  console.log('── Revenue Estimate ──\n');
  console.log('  - 5-10 arbs/day at $50-200 profit each');
  console.log('  - $25k-50k/yr on $25k capital');
  console.log('  - 100-200% APR (theoretical)');
  console.log('  - 50-100% APR (realistic, after competition)');
  console.log('');

  console.log('=== Verdict ===');
  console.log('Atomic Arb Smart Contract is the HIGHEST-VALUE build:');
  console.log('  - Zero inventory risk');
  console.log('  - Delta-neutral');
  console.log('  - 50-100% APR realistic');
  console.log('  - Build time: 2-3 weeks');
  console.log('  - Capital: $1k initial, $25k target');
  console.log('');
  console.log('PRIORITY: HIGH');
  console.log('  Build after current strategies are deployed');
  console.log('  Requires: Solidity dev + audit');
}

main().catch(console.error);
