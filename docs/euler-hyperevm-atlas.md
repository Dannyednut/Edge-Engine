# Euler V2 on HyperEVM — Contract Atlas

> **Discovery**: Oct 13 2026 via `https://raw.githubusercontent.com/euler-xyz/euler-interfaces/master/EulerChains.json`
> **Status**: Production (chain 999 active in Euler app since HypurrFi wind-down May 2026)

## Background

Euler V2 is live on HyperEVM (chain 999) via the **HypurrFi Mewler Markets** partnership.
- HypurrFi wound down in May 2026
- Euler took over the Mewler contract stack on HyperEVM
- All Euler core contracts are deployed and active

## Core Contract Addresses (verified Oct 13 2026)

### Euler Vault Kit (EVK) Core

| Contract | Address | Purpose |
|----------|---------|---------|
| **EVC** (Ethereum Vault Connector) | `0xceAA7cdCD7dDBee8601127a9Abb17A974d613db4` | Singleton — all vaults connect through this |
| **eVaultFactory** | `0xcF5552580fD364cdBBFcB5Ae345f75674c59273A` | Permissionless vault deployment |
| **eVaultImplementation** | `0x05de079A28386135E048369cdf0Bc4D326d5EBDF` | Reference vault impl |
| **eulerEarnFactory** | `0x587DD8285c01526769aB4803e4F02433ddbBc00E` | Earn vault factory (yield aggregator) |
| **protocolConfig** | `0x43144f09896F8759DE2ec6D777391B9F05A51128` | Global config |
| **sequenceRegistry** | `0x47618E4CBDcFBf5f21D6594A7e3a4f4683719994` | Sequencer |
| **balanceTracker** | `0x05d14f4eDFA7Cbfb90711C2EC5505bcbd49b9cD2` | Cross-vault balance tracking |
| **permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Permit2 (Uniswap) |

### EulerSwap V2 (NEW — DEX Integration)

| Contract | Address |
|----------|---------|
| eulerSwapV2Factory | `0xFbF2a49CB0cc50F4ccd4eAc826eF1A76D99D29Eb` |
| eulerSwapV2Implementation | `0xC00F0B7d7B4F7cA3d3f79f3892069f41C142dB84` |
| eulerSwapV2Periphery | `0x61aFC386b47a11F8721b67Eb1607cFBd9ccE48B1` |
| eulerSwapV2ProtocolFeeConfig | `0x434b1072d96ea24967CDe289D3d4d81d2BAD4F30` |
| eulerSwapV2Registry | `0x7E1Efb6A2009A1FDaDee1c5d6615260AD70c14Fb` |

### Lens Contracts (Read-only views)

| Lens | Address | Purpose |
|------|---------|---------|
| **vaultLens** | `0x46197d64f5B2381c5064B60fc19b089B58180a20` | Aggregate vault info |
| **irmLens** | `0xdA238b8296730aF885fCd446c054BE48692Dcec1` | Interest rate queries |
| **oracleLens** | `0xb6daA65cf9F4E2834c5652277F70147Cf21b3cB1` | Oracle queries |
| **accountLens** | `0x27808A1Df554a88F841AEE2E43F63D60E9077152` | Account positions |
| **utilsLens** | `0x1cd5afC7292D41D812A1D73332F29B1Aa8C70Bf1` | Utility calls |
| **eulerEarnVaultLens** | `0x023a3C1851e6B6Fa924f0ACb437DDbb441472a6e` | Earn vault info |

### Governance

| Contract | Address |
|----------|---------|
| accessControlEmergencyGovernor | `0xd27c32372cA1353c96915a05b558489aa054ef14` |
| eVaultFactoryGovernor | `0x14e280513d1D9a21493e240a29CB9Eb08E5B0e45` |
| DAO multisig | `0x48d727Cb58C9D52881C00A47db355457B712B9D7` |
| Labs multisig | `0x6b6457b7E87958819878982B153AC33fD98Cb117` |
| Security Council | `0xdC40B5C05C14Df79402c16e09fE544Ee77908A09` |
| Fee Receiver | `0x5129F2107BDe328d4c48f24AA77e00F7BF3499B5` |

### Tokens

| Token | Address | Notes |
|-------|---------|-------|
| **EUL** | `0x3A41f426E55ECdE4BC734fA79ccE991b94aFf711` | Euler governance token |
| **rEUL** | `0x14DCA6543Ef03b932cBD801FBfd70e42a9b6122b` | Staked EUL |
| **EUL OFT Adapter** | `0x976666e0ae74A8A4059cF1acf706891aDE98C3d1` | LayerZero bridge |

### Periphery / Perspectives

| Contract | Address |
|----------|---------|
| evkFactoryPerspective | `0x7bd1DADB012651606cE70210c9c4d4c94e2480a3` |
| eulerEarnFactoryPerspective | `0x455Dcb38c4969f35F698115544eA4108392c79ad` |
| eulerEarnPublicAllocator | `0xc00ae658ce425Bb668A5Ed96c8ECa9C988706939` |
| escrowedCollateralPerspective | `0xaDaDF50246512dBA23889A1eC44611B191dfF6Fc` |
| adaptiveCurveIRMFactory | `0xF62bFaA502E4dC83260e34aCF2B4875FdBDc31c9` |
| kinkIRMFactory | `0xc1254039763498485a0BC11eb51437A312641bf0` |
| oracleRouterFactory | `0x1CefA54ebBCb6c9Aa7347196B03364aFe9A89f7e` |
| swapper | `0x856bfc5a7D93503507EAeb5Ce907677d3ACb0846` |
| swapVerifier | `0x11F6386A84b04E83Ecd647Cb1f492a66B7A3Be33` |
| capRiskStewardFactory | `0x459Fe76a4fc9406feBe3AcFdb42955197059b089` |
| governorAccessControlEmergencyFactory | `0xaD9cc6ECf49376de4Ea10494Cb519a848e5e74F3` |

## Action Items

1. **BUILD**: EulerClient (read interest rates + vault states via vaultLens)
2. **BUILD**: EulerLendingArbScanner — find biggest borrow vs lend rate spreads across vaults
3. **MONITOR**: EUL token launch on HL ($0.40M mcap, low liquidity currently)
4. **MONITOR**: EulerSwap V2 deployment — may enable flashloan-style atomic arbs via Euler liquidity
5. **RESEARCH**: Try `vaultLens.aggregateVaultsInfo()` to enumerate all deployed vaults

## Future Integration Notes

- EVC uses an "account" abstraction — vaults share collateral cross-vault
- IRM (Interest Rate Model) is configurable per vault (kinked or adaptive curve)
- Liquidations are via Dutch auctions
- Permissionless vault deployment = anyone can list any asset as borrowable
