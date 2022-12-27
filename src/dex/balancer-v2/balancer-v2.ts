import { Interface } from '@ethersproject/abi';
import { DeepReadonly } from 'ts-essentials';
import _ from 'lodash';
import {
  Token,
  Address,
  ExchangePrices,
  PoolPrices,
  Log,
  AdapterExchangeParam,
  SimpleExchangeParam,
  PoolLiquidity,
  Logger,
} from '../../types';
import {
  SwapSide,
  ETHER_ADDRESS,
  NULL_ADDRESS,
  MAX_INT,
  MAX_UINT,
  Network,
  SUBGRAPH_TIMEOUT,
} from '../../constants';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { StablePool, WeightedPool } from './balancer-v2-pool';
import { PhantomStablePool } from './PhantomStablePool';
import { LinearPool } from './LinearPool';
import {
  VirtualBoostedPool,
  SwapData,
  BoostedPools,
} from './VirtualBoostedPool';
import VaultABI from '../../abi/balancer-v2/vault.json';
import WeightedPoolABI from '../../abi/balancer-v2/weighted-pool.json';
import StablePoolABI from '../../abi/balancer-v2/stable-pool.json';
import MetaStablePoolABI from '../../abi/balancer-v2/meta-stable-pool.json';
import LinearPoolABI from '../../abi/balancer-v2/linearPoolAbi.json';
import {
  StatefulEventSubscriber,
  GenerateStateResult,
} from '../../stateful-event-subscriber';
import { getDexKeysWithNetwork, getBigIntPow } from '../../utils';
import { IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper';
import {
  PoolState,
  SubgraphPoolBase,
  BalancerV2Data,
  BalancerParam,
  OptimizedBalancerV2Data,
  SwapTypes,
  PoolStateMap,
  BalancerSwap,
  PoolStateCache,
} from './types';
import { SimpleExchange } from '../simple-exchange';
import { BalancerConfig, Adapters } from './config';

const fetchAllPools = `query ($count: Int) {
  pools: pools(first: $count, orderBy: totalLiquidity, orderDirection: desc, where: {swapEnabled: true, poolType_in: ["MetaStable", "Stable", "Weighted", "LiquidityBootstrapping", "Investment", "StablePhantom", "AaveLinear", "ERC4626Linear"]}) {
    id
    address
    poolType
    tokens {
      address
      decimals
    }
    mainIndex
    wrappedIndex
    totalLiquidity
  }
}`;

const fetchWeightUpdating = `query ($count: Int, $timestampPast: Int, $timestampFuture: Int) {
  gradualWeightUpdates(
    first: $count,
    where: {startTimestamp_lt: $timestampFuture, endTimestamp_gt: $timestampPast }
  ) {
    poolId {
      address
    }
  }
}`;

// These should match the Balancer Pool types available on Subgraph
export enum BalancerPoolTypes {
  Weighted = 'Weighted',
  Stable = 'Stable',
  MetaStable = 'MetaStable',
  LiquidityBootstrapping = 'LiquidityBootstrapping',
  Investment = 'Investment',
  AaveLinear = 'AaveLinear',
  StablePhantom = 'StablePhantom',
  VirtualBoosted = 'VirtualBoosted',
  ERC4626Linear = 'ERC4626Linear',
}

const BALANCER_V2_CHUNKS = 10;
const MAX_POOL_CNT = 1000; // Taken from SOR
const POOL_CACHE_TTL = 60 * 60; // 1 hr
const POOL_EVENT_DISABLED_TTL = 5 * 60; // 5 min
const POOL_EVENT_REENABLE_DELAY = 7 * 24 * 60 * 60; // 1 week

function typecastReadOnlyPoolState(pool: DeepReadonly<PoolState>): PoolState {
  return _.cloneDeep(pool) as PoolState;
}

export class BalancerV2EventPool extends StatefulEventSubscriber<PoolStateMap> {
  public vaultInterface: Interface;

  handlers: {
    [event: string]: (event: any, pool: PoolState, log: Log) => PoolState;
  } = {};

  pools: {
    [type: string]:
      | WeightedPool
      | StablePool
      | LinearPool
      | PhantomStablePool
      | VirtualBoostedPool;
  };

  public allPools: SubgraphPoolBase[] = [];
  public virtualBoostedPools: BoostedPools = {};
  vaultDecoder: (log: Log) => any;

  eventSupportedPoolTypes = [
    'Stable',
    'Weighted',
    'LiquidityBootstrapping',
    'Investment',
  ];

  eventRemovedPools = (
    [
      // Gradual weight changes are not currently handled in event system
      // This pool keeps changing weights and is causing pricing issue
      // But should now be handled by eventDisabledPools so don't need here!
      //'0x34809aEDF93066b49F638562c42A9751eDb36DF5',
    ] as Address[]
  ).map(s => s.toLowerCase());

  constructor(
    parentName: string,
    protected network: number,
    protected vaultAddress: Address,
    protected subgraphURL: string,
    protected dexHelper: IDexHelper,
    logger: Logger,
  ) {
    super(parentName, vaultAddress, dexHelper, logger);
    this.vaultInterface = new Interface(VaultABI);
    const weightedPoolInterface = new Interface(WeightedPoolABI);
    const weightedPool = new WeightedPool(
      this.vaultAddress,
      this.vaultInterface,
      weightedPoolInterface,
    );
    const stablePoolInterface = new Interface(StablePoolABI);
    const stablePool = new StablePool(
      this.vaultAddress,
      this.vaultInterface,
      stablePoolInterface,
    );
    const metaStablePoolInterface = new Interface(MetaStablePoolABI);
    const stablePhantomPool = new PhantomStablePool(
      this.vaultAddress,
      this.vaultInterface,
      metaStablePoolInterface,
    );
    const linearPoolInterface = new Interface(LinearPoolABI);
    const linearPool = new LinearPool(
      this.vaultAddress,
      this.vaultInterface,
      linearPoolInterface,
    );

    const virtualBoostedPool = new VirtualBoostedPool(
      this.vaultAddress,
      this.vaultInterface,
      linearPoolInterface,
      metaStablePoolInterface,
    );

    this.pools = {};
    this.pools[BalancerPoolTypes.Weighted] = weightedPool;
    this.pools[BalancerPoolTypes.Stable] = stablePool;
    this.pools[BalancerPoolTypes.MetaStable] = stablePool;
    this.pools[BalancerPoolTypes.LiquidityBootstrapping] = weightedPool;
    this.pools[BalancerPoolTypes.Investment] = weightedPool;
    this.pools[BalancerPoolTypes.AaveLinear] = linearPool;
    // ERC4626Linear has the same maths and ABI as AaveLinear (has different factory)
    this.pools[BalancerPoolTypes.ERC4626Linear] = linearPool;
    this.pools[BalancerPoolTypes.StablePhantom] = stablePhantomPool;
    this.pools[BalancerPoolTypes.VirtualBoosted] = virtualBoostedPool;
    this.vaultDecoder = (log: Log) => this.vaultInterface.parseLog(log);
    this.addressesSubscribed = [vaultAddress];

    // Add default handlers
    this.handlers['Swap'] = this.handleSwap.bind(this);
    this.handlers['PoolBalanceChanged'] =
      this.handlePoolBalanceChanged.bind(this);
  }

  protected processLog(
    state: DeepReadonly<PoolStateMap>,
    log: Readonly<Log>,
  ): DeepReadonly<PoolStateMap> | null {
    const _state: PoolStateMap = {};
    for (const [address, pool] of Object.entries(state))
      _state[address] = typecastReadOnlyPoolState(pool);

    try {
      const event = this.vaultDecoder(log);
      if (event.name in this.handlers) {
        const poolAddress = event.args.poolId.slice(0, 42).toLowerCase();
        // Only update the _state if we are tracking the pool
        if (poolAddress in _state) {
          _state[poolAddress] = this.handlers[event.name](
            event,
            _state[poolAddress],
            log,
          );
        }
      }
      return _state;
    } catch (e) {
      this.logger.error(
        `Error_${this.parentName}_processLog could not parse the log with topic ${log.topics}:`,
        e,
      );
      return null;
    }
  }

  async fetchAllSubgraphPools(): Promise<SubgraphPoolBase[]> {
    const cacheKey = 'AllSubgraphPools';
    const cachedPools = await this.dexHelper.cache.get(
      this.parentName,
      this.network,
      cacheKey,
    );
    if (cachedPools) {
      const allPools = JSON.parse(cachedPools);
      this.logger.info(
        `Got ${allPools.length} ${this.parentName}_${this.network} pools from cache`,
      );
      return allPools;
    }

    this.logger.info(
      `Fetching ${this.parentName}_${this.network} Pools from subgraph`,
    );
    const variables = {
      count: MAX_POOL_CNT,
    };
    const { data } = await this.dexHelper.httpRequest.post(
      this.subgraphURL,
      { query: fetchAllPools, variables },
      SUBGRAPH_TIMEOUT,
    );

    if (!(data && data.pools))
      throw new Error('Unable to fetch pools from the subgraph');

    this.dexHelper.cache.setex(
      this.parentName,
      this.network,
      cacheKey,
      POOL_CACHE_TTL,
      JSON.stringify(data.pools),
    );
    const allPools = data.pools;
    this.logger.info(
      `Got ${allPools.length} ${this.parentName}_${this.network} pools from subgraph`,
    );
    return allPools;
  }

  async generateState(
    blockNumber: number,
  ): Promise<GenerateStateResult<PoolStateMap>> {
    const subgraphPools = await this.fetchAllSubgraphPools();
    const virtualBoostedPools = VirtualBoostedPool.createPools(subgraphPools);
    this.virtualBoostedPools = virtualBoostedPools.dictionary;
    // Add the virtual pools to the list of all pools from the Subgraph
    const allPools = [...virtualBoostedPools.subgraph, ...subgraphPools];
    this.allPools = allPools;
    const eventSupportedPools = allPools.filter(
      pool =>
        this.eventSupportedPoolTypes.includes(pool.poolType) &&
        !this.eventRemovedPools.includes(pool.address.toLowerCase()),
    );
    const allPoolsLatestState = await this.getOnChainState(
      eventSupportedPools,
      blockNumber,
    );
    return {
      blockNumber,
      state: allPoolsLatestState,
    };
  }

  handleSwap(event: any, pool: PoolState, log: Log): PoolState {
    const tokenIn = event.args.tokenIn.toLowerCase();
    const amountIn = BigInt(event.args.amountIn.toString());
    const tokenOut = event.args.tokenOut.toLowerCase();
    const amountOut = BigInt(event.args.amountOut.toString());
    pool.tokens[tokenIn].balance += amountIn;
    pool.tokens[tokenOut].balance -= amountOut;
    return pool;
  }

  handlePoolBalanceChanged(event: any, pool: PoolState, log: Log): PoolState {
    const tokens = event.args.tokens.map((t: string) => t.toLowerCase());
    const deltas = event.args.deltas.map((d: any) => BigInt(d.toString()));
    const fees = event.args.protocolFeeAmounts.map((d: any) =>
      BigInt(d.toString()),
    ) as bigint[];
    tokens.forEach((t: string, i: number) => {
      const diff = deltas[i] - fees[i];
      pool.tokens[t].balance += diff;
    });
    return pool;
  }

  isSupportedPool(poolType: string): boolean {
    const supportedPoolTypes: string[] = Object.values(BalancerPoolTypes);
    return supportedPoolTypes.includes(poolType);
  }

  getPricesPool(
    from: Token,
    to: Token,
    pool: SubgraphPoolBase,
    poolStates: { [address: string]: PoolState },
    amounts: bigint[],
    unitVolume: bigint,
    side: SwapSide,
  ): { unit: bigint; prices: bigint[]; gasCost: number } | null {
    if (!this.isSupportedPool(pool.poolType)) {
      this.logger.error(`Unsupported Pool Type: ${pool.poolType}`);
      return null;
    }

    const _amounts = [unitVolume, ...amounts.slice(1)];

    const poolPairData = this.pools[pool.poolType].parsePoolPairData(
      pool,
      poolStates,
      from.address,
      to.address,
      this.virtualBoostedPools,
    );

    if (
      !this.pools[pool.poolType].checkBalance(
        amounts,
        unitVolume,
        side,
        poolPairData as any,
      )
    )
      return null;

    const _prices = this.pools[pool.poolType].onSell(
      _amounts,
      poolPairData as any,
    );
    return {
      unit: _prices[0],
      prices: [0n, ..._prices.slice(1)],
      gasCost: poolPairData.gasCost,
    };
  }

  async getOnChainState(
    subgraphPoolBase: SubgraphPoolBase[],
    blockNumber: number,
  ): Promise<PoolStateMap> {
    const multiCallData = subgraphPoolBase
      .map(pool => {
        if (!this.isSupportedPool(pool.poolType)) return [];

        return this.pools[pool.poolType].getOnChainCalls(
          pool,
          this.virtualBoostedPools,
        );
      })
      .flat();

    // 500 is an arbitrary number chosen based on the blockGasLimit
    const slicedMultiCallData = _.chunk(multiCallData, 500);

    const returnData = (
      await Promise.all(
        slicedMultiCallData.map(async _multiCallData =>
          this.dexHelper.multiContract.methods
            .tryAggregate(false, _multiCallData)
            .call({}, blockNumber),
        ),
      )
    ).flat();

    let i = 0;
    const onChainStateMap = subgraphPoolBase.reduce(
      (acc: { [address: string]: PoolState }, pool) => {
        if (!this.isSupportedPool(pool.poolType)) return acc;

        const [decoded, newIndex] = this.pools[
          pool.poolType
        ].decodeOnChainCalls(pool, returnData, i, this.virtualBoostedPools);
        i = newIndex;
        acc = { ...acc, ...decoded };
        return acc;
      },
      {},
    );

    return onChainStateMap;
  }
}

export class BalancerV2
  extends SimpleExchange
  implements IDex<BalancerV2Data, BalancerParam, OptimizedBalancerV2Data>
{
  protected eventPools: BalancerV2EventPool;
  // Stores subgraph pools for updatePoolState/getTopPoolsForToken
  allPools?: SubgraphPoolBase[];

  readonly hasConstantPriceLargeAmounts = false;
  readonly isFeeOnTransferSupported = false;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(BalancerConfig);

  logger: Logger;

  // In memory pool state for non-event pools
  nonEventPoolStateCache: PoolStateCache;

  eventDisabledPoolsTimer?: NodeJS.Timer;
  eventDisabledPools: Address[] = [];

  constructor(
    protected network: Network,
    dexKey: string,
    protected dexHelper: IDexHelper,
    protected vaultAddress: Address = BalancerConfig[dexKey][network]
      .vaultAddress,
    protected subgraphURL: string = BalancerConfig[dexKey][network].subgraphURL,
    protected adapters = Adapters[network],
  ) {
    super(dexHelper, dexKey);
    // Initialise cache - this will hold pool state of non-event pools in memory to be reused if block hasn't expired
    this.nonEventPoolStateCache = { blockNumber: 0, poolState: {} };
    this.logger = dexHelper.getLogger(dexKey);
    this.eventPools = new BalancerV2EventPool(
      dexKey,
      network,
      vaultAddress,
      subgraphURL,
      dexHelper,
      this.logger,
    );
  }

  async setupEventPools(blockNumber: number) {
    await this.eventPools.initialize(blockNumber);
  }

  async fetchEventDisabledPools() {
    const cacheKey = 'eventDisabledPools';
    const poolAddressListFromCache = await this.dexHelper.cache.get(
      this.dexKey,
      this.network,
      cacheKey,
    );
    if (poolAddressListFromCache) {
      this.eventDisabledPools = JSON.parse(poolAddressListFromCache);
      return;
    }
    this.logger.info(
      `Fetching ${this.dexKey}_${this.network} Weight Updates from subgraph`,
    );
    const timeNow = Math.floor(Date.now() / 1000);
    const variables = {
      count: MAX_POOL_CNT,
      timestampPast: timeNow - POOL_EVENT_REENABLE_DELAY,
      timestampFuture: timeNow + POOL_EVENT_DISABLED_TTL,
    };
    const { data } = await this.dexHelper.httpRequest.post(
      this.subgraphURL,
      { query: fetchWeightUpdating, variables },
      SUBGRAPH_TIMEOUT,
    );

    if (!(data && data.gradualWeightUpdates)) {
      throw new Error(
        `${this.dexKey}_${this.network} failed to fetch weight updates from subgraph`,
      );
    }

    this.eventDisabledPools = _.uniq(
      data.gradualWeightUpdates.map(
        (wu: { poolId: { address: Address } }) => wu.poolId.address,
      ),
    );
    const poolAddressList = JSON.stringify(this.eventDisabledPools);
    this.logger.info(
      `Pools blocked from event based on ${this.dexKey}_${this.network}: ${poolAddressList}`,
    );
    this.dexHelper.cache.setex(
      this.dexKey,
      this.network,
      cacheKey,
      POOL_EVENT_DISABLED_TTL,
      poolAddressList,
    );
  }

  async initializePricing(blockNumber: number) {
    if (!this.eventDisabledPoolsTimer) {
      await this.fetchEventDisabledPools();
      this.eventDisabledPoolsTimer = setInterval(async () => {
        try {
          await this.fetchEventDisabledPools();
        } catch (e) {
          this.logger.error(
            `${this.dexKey}: Failed to update event disabled pools:`,
            e,
          );
        }
      }, POOL_EVENT_DISABLED_TTL * 1000);
    }
    await this.setupEventPools(blockNumber);
  }

  releaseResources(): void {
    if (this.eventDisabledPoolsTimer) {
      clearInterval(this.eventDisabledPoolsTimer);
      this.eventDisabledPoolsTimer = undefined;
      this.logger.info(
        `${this.dexKey}: cleared eventDisabledPoolsTimer before shutting down`,
      );
    }
  }

  getPools(from: Token, to: Token): SubgraphPoolBase[] {
    return this.eventPools.allPools
      .filter(
        p =>
          p.tokens.some(
            token => token.address.toLowerCase() === from.address.toLowerCase(),
          ) &&
          p.tokens.some(
            token => token.address.toLowerCase() === to.address.toLowerCase(),
          ),
      )
      .slice(0, 10);
  }

  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    if (side === SwapSide.BUY) return null;
    return this.adapters;
  }

  async getPoolIdentifiers(
    from: Token,
    to: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    if (side === SwapSide.BUY) return [];
    const _from = this.dexHelper.config.wrapETH(from);
    const _to = this.dexHelper.config.wrapETH(to);

    const pools = this.getPools(_from, _to);

    const identifiers: string[] = [];

    pools.forEach(p => {
      identifiers.push(`${this.dexKey}_${p.address.toLowerCase()}`);
      if (p.poolType === 'VirtualBoosted') {
        identifiers.push(
          `${this.dexKey}_${p.address.toLowerCase()}virtualboosted`,
        );
        // VirtualBoosted pool should return identifiers for all the internal pools
        // e.g. for bbausd this is 3 Linear pools and the PhantomStable linking them
        p.tokens.forEach(t =>
          identifiers.push(`${this.dexKey}_${t.linearPoolAddr?.toLowerCase()}`),
        );
      }
    });

    return identifiers;
  }

  /**
   * Returns cached poolState if blockNumber matches cached value. Resets if not.
   */
  private getNonEventPoolStateCache(blockNumber: number): PoolStateMap {
    if (this.nonEventPoolStateCache.blockNumber !== blockNumber)
      this.nonEventPoolStateCache.poolState = {};
    return this.nonEventPoolStateCache.poolState;
  }

  /**
   * Update poolState cache.
   * If same blockNumber as current cache then update with new pool state.
   * If different blockNumber overwrite cache with latest.
   */
  private updateNonEventPoolStateCache(
    poolState: PoolStateMap,
    blockNumber: number,
  ): PoolStateMap {
    if (this.nonEventPoolStateCache.blockNumber !== blockNumber) {
      this.nonEventPoolStateCache.blockNumber = blockNumber;
      this.nonEventPoolStateCache.poolState = poolState;
    } else
      this.nonEventPoolStateCache.poolState = {
        ...this.nonEventPoolStateCache.poolState,
        ...poolState,
      };
    return this.nonEventPoolStateCache.poolState;
  }

  async getPricesVolume(
    from: Token,
    to: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<BalancerV2Data>> {
    if (side === SwapSide.BUY) return null;
    try {
      const _from = this.dexHelper.config.wrapETH(from);
      const _to = this.dexHelper.config.wrapETH(to);

      const poolsWithTokens = this.getPools(_from, _to);

      // limit pools are IDS of pools we can use (preceded with BalancerV2_)
      // poolsWithTokens contains pool data for pools with tokenIn/Out
      // allowedPools contains pool data for pools with tokenIn/Out that are in limit list
      const allowedPools = limitPools
        ? poolsWithTokens.filter(pool => {
            if (
              !limitPools.includes(
                `${this.dexKey}_${pool.address.toLowerCase()}`,
              )
            )
              return false;

            const id = pool.id.split(pool.poolType.toLowerCase())[0];
            // VirtualPools must have all their internal pools in limitPools
            if (this.eventPools.virtualBoostedPools[id]) {
              if (
                !limitPools.includes(
                  `${this.dexKey}_${pool.address.toLowerCase()}virtualboosted`,
                )
              )
                return false;

              for (let t of this.eventPools.virtualBoostedPools[id]
                .mainTokens) {
                if (
                  !limitPools.includes(
                    `${this.dexKey}_${t.linearPoolAddr.toLowerCase()}`,
                  )
                )
                  return false;
              }
            }

            return true;
          })
        : poolsWithTokens;

      if (!allowedPools.length) return null;

      const unitVolume = getBigIntPow(
        (side === SwapSide.SELL ? _from : _to).decimals,
      );

      const eventPoolStatesRO = await this.eventPools.getState(blockNumber);
      if (!eventPoolStatesRO) {
        this.logger.error(`getState returned null`);
      }
      const eventPoolStates = { ...(eventPoolStatesRO || {}) };
      for (const addr of this.eventDisabledPools) delete eventPoolStates[addr];

      // Fetch previously cached non-event pool states
      let nonEventPoolStates = this.getNonEventPoolStateCache(blockNumber);

      // Missing pools are pools that don't already exist in event or non-event
      const missingPools = allowedPools.filter(
        pool =>
          !(
            pool.address.toLowerCase() in eventPoolStates ||
            pool.address.toLowerCase() in nonEventPoolStates
          ),
      );

      // Retrieve onchain state for any missing pools
      if (missingPools.length > 0) {
        const missingPoolsStateMap = await this.eventPools.getOnChainState(
          missingPools,
          blockNumber,
        );
        // Update non-event pool state cache with newly retrieved data so it can be reused in future
        nonEventPoolStates = this.updateNonEventPoolStateCache(
          missingPoolsStateMap,
          blockNumber,
        );
      }

      const completePoolStates = {
        ...eventPoolStatesRO,
        ...nonEventPoolStates,
      };

      const poolPrices = allowedPools
        .map((pool: SubgraphPoolBase) => {
          const poolAddress = pool.address.toLowerCase();
          const poolState =
            eventPoolStates[poolAddress] || nonEventPoolStates[poolAddress];
          if (!poolState) {
            this.logger.error(`Unable to find the poolState ${poolAddress}`);
            return null;
          }
          // TODO: re-check what should be the current block time stamp
          try {
            const res = this.eventPools.getPricesPool(
              _from,
              _to,
              pool,
              completePoolStates,
              amounts,
              unitVolume,
              side,
            );
            if (!res) return null;

            let poolAddresses = [poolAddress];
            const id = pool.id.split(pool.poolType.toLowerCase())[0];
            if (this.eventPools.virtualBoostedPools[id]) {
              this.eventPools.virtualBoostedPools[id].mainTokens.forEach(t => {
                poolAddresses.push(t.linearPoolAddr.toLowerCase());
              });
            }

            return {
              unit: res.unit,
              prices: res.prices,
              data: {
                poolId: pool.id,
              },
              poolAddresses,
              exchange: this.dexKey,
              gasCost: res.gasCost,
              poolIdentifier: `${this.dexKey}_${pool.id}`,
            };
          } catch (e) {
            this.logger.error(
              `Error_getPrices ${from.symbol || from.address}, ${
                to.symbol || to.address
              }, ${side}, ${pool.address}:`,
              e,
            );
            return null;
          }
        })
        .filter(p => !!p);
      return poolPrices as ExchangePrices<BalancerV2Data>;
    } catch (e) {
      this.logger.error(
        `Error_getPrices ${from.symbol || from.address}, ${
          to.symbol || to.address
        }, ${side}:`,
        e,
      );
      return null;
    }
  }

  // Returns estimated gas cost of calldata for this DEX in multiSwap
  getCalldataGasCost(
    poolPrices: PoolPrices<BalancerV2Data>,
  ): number | number[] {
    return (
      CALLDATA_GAS_COST.DEX_OVERHEAD +
      CALLDATA_GAS_COST.LENGTH_LARGE +
      // ParentStruct header
      CALLDATA_GAS_COST.OFFSET_SMALL +
      // ParentStruct -> swaps[] header
      CALLDATA_GAS_COST.OFFSET_LARGE +
      // ParentStruct -> assets[] header
      CALLDATA_GAS_COST.OFFSET_LARGE +
      // ParentStruct -> funds
      CALLDATA_GAS_COST.ADDRESS +
      CALLDATA_GAS_COST.BOOL +
      CALLDATA_GAS_COST.ADDRESS +
      CALLDATA_GAS_COST.BOOL +
      // ParentStruct -> limits[] header
      CALLDATA_GAS_COST.OFFSET_LARGE +
      // ParentStruct -> deadline
      CALLDATA_GAS_COST.TIMESTAMP +
      // ParentStruct -> swaps[]
      CALLDATA_GAS_COST.LENGTH_SMALL +
      // ParentStruct -> swaps[0] header
      CALLDATA_GAS_COST.OFFSET_SMALL +
      // ParentStruct -> swaps[0] -> poolId
      CALLDATA_GAS_COST.FULL_WORD +
      // ParentStruct -> swaps[0] -> assetInIndex
      CALLDATA_GAS_COST.INDEX +
      // ParentStruct -> swaps[0] -> assetOutIndex
      CALLDATA_GAS_COST.INDEX +
      // ParentStruct -> swaps[0] -> amount
      CALLDATA_GAS_COST.AMOUNT +
      // ParentStruct -> swaps[0] -> userData header
      CALLDATA_GAS_COST.OFFSET_SMALL +
      // ParentStruct -> swaps[0] -> userData
      CALLDATA_GAS_COST.ZERO +
      // ParentStruct -> assets[]
      CALLDATA_GAS_COST.LENGTH_SMALL +
      // ParentStruct -> assets[0:2]
      CALLDATA_GAS_COST.ADDRESS * 2 +
      // ParentStruct -> limits[]
      CALLDATA_GAS_COST.LENGTH_SMALL +
      // ParentStruct -> limits[0:2]
      CALLDATA_GAS_COST.FULL_WORD * 2
    );
  }

  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: OptimizedBalancerV2Data,
    side: SwapSide,
  ): AdapterExchangeParam {
    const params = this.getBalancerParam(
      srcToken,
      destToken,
      srcAmount,
      destAmount,
      data,
      side,
    );

    const payload = this.abiCoder.encodeParameter(
      {
        ParentStruct: {
          'swaps[]': {
            poolId: 'bytes32',
            assetInIndex: 'uint256',
            assetOutIndex: 'uint256',
            amount: 'uint256',
            userData: 'bytes',
          },
          assets: 'address[]',
          funds: {
            sender: 'address',
            fromInternalBalance: 'bool',
            recipient: 'address',
            toInternalBalance: 'bool',
          },
          limits: 'int256[]',
          deadline: 'uint256',
        },
      },
      {
        swaps: params[1],
        assets: params[2],
        funds: params[3],
        limits: params[4],
        deadline: params[5],
      },
    );

    return {
      targetExchange: this.vaultAddress,
      payload,
      networkFee: '0',
    };
  }

  updateSwapAsset(
    tokenIndex: number,
    swapAssets: string[],
    currentAssets: string[],
  ): number {
    const token = swapAssets[tokenIndex];
    const currentIndex = currentAssets.indexOf(token);
    if (currentIndex === -1) {
      currentAssets.push(token);
      return currentAssets.length - 1;
    } else {
      return currentIndex;
    }
  }

  updateSwapAssets(swapData: SwapData, currentAssets: string[]): SwapData {
    // Update currentAssets. By the end it will contain all assets from all swaps.
    // Update each swap index to match currentAsset
    swapData.swaps.forEach(swap => {
      swap.assetInIndex = this.updateSwapAsset(
        swap.assetInIndex,
        swapData.assets,
        currentAssets,
      );
      swap.assetOutIndex = this.updateSwapAsset(
        swap.assetOutIndex,
        swapData.assets,
        currentAssets,
      );
    });
    return swapData;
  }

  getBalancerParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: OptimizedBalancerV2Data,
    side: SwapSide,
  ): BalancerParam {
    // assets array will contain list of all assets used in all swaps
    let assets: string[] = [srcToken, destToken];
    // swap asset indices will be match to assets array
    let swaps: BalancerSwap[] = [];

    // swaps contains poolId and amount data
    data.swaps.forEach(swap => {
      if (swap.poolId.includes(VirtualBoostedPool.poolType.toLowerCase())) {
        // VirtualBoostedPools swaps will consist of multihops.
        // getSwapData will construct the relevant swaps, assets and limits
        const swapData = VirtualBoostedPool.getSwapData(
          srcToken,
          destToken,
          swap.poolId,
          swap.amount,
          this.eventPools.virtualBoostedPools,
        );

        // Update assets and swaps with any new assets or indices
        const updatedSwaps = this.updateSwapAssets(swapData, assets);
        swaps = [...swaps, ...updatedSwaps.swaps];
      } else {
        // Non-virtual pools will be a direct swap src>dst
        swaps.push({
          poolId: swap.poolId,
          assetInIndex: 0,
          assetOutIndex: 1,
          amount: swap.amount,
          userData: '0x',
        });
      }
    });

    // BalancerV2 Uses Address(0) as ETH
    assets = assets.map(t =>
      t.toLowerCase() === ETHER_ADDRESS.toLowerCase() ? NULL_ADDRESS : t,
    );

    const limits: string[] = Array(assets.length).fill(MAX_INT);

    const funds = {
      sender: this.augustusAddress,
      recipient: this.augustusAddress,
      fromInternalBalance: false,
      toInternalBalance: false,
    };

    const params: BalancerParam = [
      side === SwapSide.SELL ? SwapTypes.SwapExactIn : SwapTypes.SwapExactOut,
      swaps,
      assets,
      funds,
      limits,
      MAX_UINT,
    ];

    return params;
  }

  async getSimpleParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: OptimizedBalancerV2Data,
    side: SwapSide,
  ): Promise<SimpleExchangeParam> {
    const params = this.getBalancerParam(
      srcToken,
      destToken,
      srcAmount,
      destAmount,
      data,
      side,
    );

    const swapData = this.eventPools.vaultInterface.encodeFunctionData(
      'batchSwap',
      params,
    );

    return this.buildSimpleParamWithoutWETHConversion(
      srcToken,
      srcAmount,
      destToken,
      destAmount,
      swapData,
      this.vaultAddress,
    );
  }

  // This is called once before getTopPoolsForToken is
  // called for multiple tokens. This can be helpful to
  // update common state required for calculating
  // getTopPoolsForToken. It is optional for a DEX
  // to implement this
  async updatePoolState(): Promise<void> {
    const query = `
      query {
          pools: pools(first: 1000, orderBy: totalLiquidity, orderDirection: desc, where: {swapEnabled: true, poolType_in: ["MetaStable", "Stable", "Weighted", "LiquidityBootstrapping", "Investment", "StablePhantom", "AaveLinear", "ERC4626Linear"]}) {
            id
            address
            poolType
            tokens {
              address
              decimals
            }
            mainIndex
            wrappedIndex
            totalLiquidity
            tokensList
          }
      }`;

    const { data } = await this.dexHelper.httpRequest.post(
      this.subgraphURL,
      { query },
      SUBGRAPH_TIMEOUT,
    );

    if (!(data && data.pools))
      throw new Error(
        `Error_${this.dexKey}_Subgraph: couldn't fetch the pools from the subgraph`,
      );

    // Create virtual pool info
    const virtualBoostedPools = VirtualBoostedPool.createPools(data.pools);

    // Combine virtual pools with sg pools and order by liquidity
    this.allPools = [...data.pools, ...virtualBoostedPools.subgraph].sort(
      (a, b) => b.totalLiquidity - a.totalLiquidity,
    );
  }

  async getTopPoolsForToken(
    tokenAddress: Address,
    count: number,
  ): Promise<PoolLiquidity[]> {
    if (!this.allPools) await this.updatePoolState();

    const poolsWithToken = this.allPools
      ?.filter(p =>
        p.tokens.some(
          token => token.address.toLowerCase() === tokenAddress.toLowerCase(),
        ),
      )
      .slice(0, count);

    const pools = _.map(poolsWithToken, (pool: any) => ({
      exchange: this.dexKey,
      address: pool.address.toLowerCase(),
      connectorTokens: pool.tokens.reduce(
        (
          acc: Token[],
          { decimals, address }: { decimals: number; address: string },
        ) => {
          if (address.toLowerCase() != tokenAddress.toLowerCase())
            acc.push({ decimals, address: address.toLowerCase() });
          return acc;
        },
        [],
      ),
      liquidityUSD: parseFloat(pool.totalLiquidity),
    }));

    return pools;
  }
}
