import { ethers } from 'ethers';
import { EventEmitter } from 'events';

// Interfaces for type safety
interface PriceData {
  token: string;
  exchange: string;
  price: number;
  timestamp: number;
}

interface TokenPair {
  token0: string; // Token address
  token1: string; // Token address
  pairAddress?: string; // The address of the pair contract (if known)
}

interface DexConfig {
  name: string;
  routerAddress: string;
  factoryAddress: string;
  supportedPairs: TokenPair[];
  routerAbi: any;
  factoryAbi: any;
  pairAbi: any;
}

interface PriceUpdate {
  pair: TokenPair;
  exchange: string;
  price: number;
}

/**
 * PricePulseNexus
 * 
 * Responsible for aggregating real-time price data from various DEXs on Ethereum.
 * Acts as the data layer for the arbitrage bot.
 */
export class PricePulseNexus extends EventEmitter {
  private provider: ethers.providers.Provider;
  private dexes: DexConfig[];
  private priceCache: Map<string, PriceData>;
  private isPolling: boolean;
  private pollInterval: number; // in milliseconds
  private routerContracts: Map<string, ethers.Contract>;
  private factoryContracts: Map<string, ethers.Contract>;
  private pairContracts: Map<string, ethers.Contract>;
  
  /**
   * Constructor for PricePulseNexus
   * @param provider - Ethereum provider
   * @param dexes - List of DEX configurations
   * @param pollInterval - How often to poll for prices (ms)
   */
  constructor(
    provider: ethers.providers.Provider,
    dexes: DexConfig[],
    pollInterval: number = 10000 // Default 10 seconds
  ) {
    super();
    this.provider = provider;
    this.dexes = dexes;
    this.priceCache = new Map<string, PriceData>();
    this.isPolling = false;
    this.pollInterval = pollInterval;
    this.routerContracts = new Map<string, ethers.Contract>();
    this.factoryContracts = new Map<string, ethers.Contract>();
    this.pairContracts = new Map<string, ethers.Contract>();
    
    // Initialize DEX contracts
    this.initializeContracts();
  }
  
  /**
   * Initialize connection to DEX contracts
   */
  private initializeContracts(): void {
    for (const dex of this.dexes) {
      try {
        // Initialize router contract
        const routerContract = new ethers.Contract(
          dex.routerAddress,
          dex.routerAbi,
          this.provider
        );
        this.routerContracts.set(dex.name, routerContract);
        
        // Initialize factory contract
        const factoryContract = new ethers.Contract(
          dex.factoryAddress,
          dex.factoryAbi,
          this.provider
        );
        this.factoryContracts.set(dex.name, factoryContract);
        
        console.log(`Initialized contracts for ${dex.name}`);
      } catch (error) {
        console.error(`Failed to initialize contracts for ${dex.name}:`, error);
      }
    }
  }
  
  /**
   * Start polling for price updates
   */
  public startPolling(): void {
    if (this.isPolling) return;
    
    this.isPolling = true;
    this.poll();
    
    // Setup event listeners for relevant DEX events
    this.setupEventListeners();
    
    console.log(`PricePulseNexus started polling at interval of ${this.pollInterval}ms`);
  }
  
  /**
   * Stop polling for price updates
   */
  public stopPolling(): void {
    this.isPolling = false;
    console.log('PricePulseNexus stopped polling');
    
    // Clean up event listeners
    this.removeAllListeners();
  }
  
  /**
   * Poll for price updates
   */
  private async poll(): Promise<void> {
    if (!this.isPolling) return;
    
    try {
      await this.fetchAllPrices();
    } catch (error) {
      console.error('Error polling prices:', error);
    }
    
    // Schedule next poll
    setTimeout(() => this.poll(), this.pollInterval);
  }
  
  /**
   * Setup blockchain event listeners for DEX events
   */
  private setupEventListeners(): void {
    // For each DEX, set up event listeners for all pair contracts
    for (const dex of this.dexes) {
      for (const pair of dex.supportedPairs) {
        this.setupPairEventListener(dex, pair);
      }
    }
  }
  
  /**
   * Set up event listener for a specific trading pair
   */
  private async setupPairEventListener(dex: DexConfig, pair: TokenPair): Promise<void> {
    try {
      // Get pair address if not provided
      const pairAddress = pair.pairAddress || await this.getPairAddress(dex, pair);
      if (!pairAddress) {
        console.error(`Pair address not found for ${pair.token0}/${pair.token1} on ${dex.name}`);
        return;
      }
      
      // Create pair contract
      const pairContract = new ethers.Contract(
        pairAddress,
        dex.pairAbi,
        this.provider
      );
      
      // Store the pair contract
      const pairKey = this.generatePairKey(dex.name, pair);
      this.pairContracts.set(pairKey, pairContract);
      
      // Listen for Swap events
      pairContract.on('Swap', async (...args) => {
        const eventData = args[args.length - 1];
        console.log(`Swap event detected for ${pair.token0}/${pair.token1} on ${dex.name}`);
        
        // Update price for this pair
        await this.fetchPairPrice(dex, pair);
      });
      
      console.log(`Event listener set up for ${pair.token0}/${pair.token1} on ${dex.name}`);
    } catch (error) {
      console.error(`Error setting up event listener for ${pair.token0}/${pair.token1} on ${dex.name}:`, error);
    }
  }
  
  /**
   * Get the address of a trading pair contract from the factory
   */
  private async getPairAddress(dex: DexConfig, pair: TokenPair): Promise<string> {
    try {
      const factoryContract = this.factoryContracts.get(dex.name);
      if (!factoryContract) {
        throw new Error(`Factory contract not initialized for ${dex.name}`);
      }
      
      // Call getPair on the factory (works for Uniswap V2 style DEXes)
      const pairAddress = await factoryContract.getPair(pair.token0, pair.token1);
      
      // Check if pair exists
      if (pairAddress === ethers.constants.AddressZero) {
        throw new Error(`Pair does not exist for ${pair.token0}/${pair.token1} on ${dex.name}`);
      }
      
      return pairAddress;
    } catch (error) {
      console.error(`Error getting pair address for ${pair.token0}/${pair.token1} on ${dex.name}:`, error);
      throw error;
    }
  }
  
  /**
   * Fetch all prices from all configured DEXes
   */
  private async fetchAllPrices(): Promise<void> {
    const fetchPromises: Promise<void>[] = [];
    
    for (const dex of this.dexes) {
      for (const pair of dex.supportedPairs) {
        fetchPromises.push(this.fetchPairPrice(dex, pair));
      }
    }
    
    await Promise.allSettled(fetchPromises);
  }
  
  /**
   * Fetch price for a specific token pair on a specific DEX
   */
  private async fetchPairPrice(dex: DexConfig, pair: TokenPair): Promise<void> {
    try {
      // Get pair contract (or create if doesn't exist yet)
      const pairKey = this.generatePairKey(dex.name, pair);
      let pairContract = this.pairContracts.get(pairKey);
      
      if (!pairContract) {
        const pairAddress = pair.pairAddress || await this.getPairAddress(dex, pair);
        if (!pairAddress) {
          throw new Error(`Pair address not found for ${pair.token0}/${pair.token1} on ${dex.name}`);
        }
        
        pairContract = new ethers.Contract(pairAddress, dex.pairAbi, this.provider);
        this.pairContracts.set(pairKey, pairContract);
      }
      
      // Get reserves from the pair contract
      const reserves = await pairContract.getReserves();
      
      // Get token addresses to determine order
      const token0Address = await pairContract.token0();
      
      // Calculate price based on which token is token0 in the pair
      let price: number;
      if (token0Address.toLowerCase() === pair.token0.toLowerCase()) {
        // pair.token0 is token0 in the pair contract
        price = parseFloat(ethers.utils.formatEther(reserves[1])) / 
                parseFloat(ethers.utils.formatEther(reserves[0]));
      } else {
        // pair.token0 is token1 in the pair contract
        price = parseFloat(ethers.utils.formatEther(reserves[0])) / 
                parseFloat(ethers.utils.formatEther(reserves[1]));
      }
      
      // Update price in cache
      const priceData: PriceData = {
        token: `${pair.token0}/${pair.token1}`,
        exchange: dex.name,
        price,
        timestamp: Date.now()
      };
      
      this.priceCache.set(pairKey, priceData);
      
      // Emit price update event
      const priceUpdate: PriceUpdate = {
        pair,
        exchange: dex.name,
        price
      };
      
      this.emit('priceUpdate', priceUpdate);
      
      return;
    } catch (error) {
      console.error(`Error fetching price for ${pair.token0}/${pair.token1} on ${dex.name}:`, error);
    }
  }
  
  /**
   * Generate a unique key for a pair contract
   */
  private generatePairKey(dexName: string, pair: TokenPair): string {
    return `${dexName}_${pair.token0}_${pair.token1}`;
  }
  
  /**
   * Get the current price for a token pair across all DEXes
   */
  public getPricesForPair(token0: string, token1: string): PriceData[] {
    const prices: PriceData[] = [];
    
    for (const [key, priceData] of this.priceCache.entries()) {
      if (priceData.token === `${token0}/${token1}` || priceData.token === `${token1}/${token0}`) {
        prices.push(priceData);
      }
    }
    
    return prices;
  }
  
  /**
   * Get latest price for a specific pair on a specific DEX
   */
  public getPrice(dexName: string, token0: string, token1: string): PriceData | undefined {
    const key = this.generatePairKey(dexName, { token0, token1 });
    return this.priceCache.get(key);
  }
  
  /**
   * Check if a price is stale (older than maxAge)
   */
  public isPriceStale(priceData: PriceData, maxAge: number = 60000): boolean {
    const now = Date.now();
    return (now - priceData.timestamp) > maxAge;
  }
  
  /**
   * Force an immediate refresh of all prices
   */
  public async refreshPrices(): Promise<void> {
    await this.fetchAllPrices();
  }
  
  /**
   * Get a list of all DEXes where a pair is available
   */
  public getDexesForPair(token0: string, token1: string): string[] {
    const dexes: string[] = [];
    
    for (const dex of this.dexes) {
      const hasPair = dex.supportedPairs.some(
        pair => (pair.token0 === token0 && pair.token1 === token1) || 
                (pair.token0 === token1 && pair.token1 === token0)
      );
      
      if (hasPair) {
        dexes.push(dex.name);
      }
    }
    
    return dexes;
  }
  
  /**
   * Get price differences for a token pair between different DEXes
   * Returns an array of price differences sorted by absolute difference (descending)
   */
  public getPriceDifferencesForPair(token0: string, token1: string): Array<{dex1: string, dex2: string, priceDiff: number, priceDiffPercent: number}> {
    const prices = this.getPricesForPair(token0, token1);
    const priceDiffs: Array<{dex1: string, dex2: string, priceDiff: number, priceDiffPercent: number}> = [];
    
    // Calculate price differences between all pairs of DEXes
    for (let i = 0; i < prices.length; i++) {
      for (let j = i + 1; j < prices.length; j++) {
        const price1 = prices[i].price;
        const price2 = prices[j].price;
        
        const priceDiff = price2 - price1;
        const priceDiffPercent = (priceDiff / price1) * 100;
        
        priceDiffs.push({
          dex1: prices[i].exchange,
          dex2: prices[j].exchange,
          priceDiff,
          priceDiffPercent
        });
      }
    }
    
    // Sort by absolute difference (descending)
    return priceDiffs.sort((a, b) => Math.abs(b.priceDiff) - Math.abs(a.priceDiff));
  }
}

export default PricePulseNexus;
