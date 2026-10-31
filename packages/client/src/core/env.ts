import type { Address } from 'viem';
import { normalizeAddress } from './address';
import { UserInputError } from './errors';

/** The typed configuration every client uses: URLs, chain id and contract addresses. */
export interface EnvironmentConfig {
  name: string;
  chainId: number;
  backendUrl: string;
  backendSocketUrl: string;
  orderbookUrl: string;
  orderbookMarketWsUrl: string;
  orderbookUserWsUrl: string;
  /**
   * This environment's gas path is the sponsor: the service that pays the gas of sponsored
   * transactions, for plain wallets and smart wallets alike. {@link production} has one.
   * Without it, only `rail: 'direct'` (a plain wallet that pays its own gas) can send.
   */
  sponsorUrl?: string;
  /**
   * Whether this environment has the deposit and withdrawal bridge. Leave it out, or set it to
   * `false`, when it has none: every deposit and withdrawal member then fails with
   * `bridge_not_available` before any request. {@link production} has it (`true`). Set it to
   * `true` on a custom config whose backend serves the bridge routes.
   */
  bridge?: boolean;
  rpcUrl: string;
  /**
   * The `domain` of the SIWE (EIP-4361) message the backend issues for a wallet login,
   * for example `beta.xo.market`. The SDK signs a login message only if it names this
   * domain, so a compromised or look-alike server cannot get a signature for another site.
   */
  siweDomain: string;
  /** The `URI` of that message, for example `https://beta.xo.market`. Compared as written. */
  siweUri: string;
  contracts: {
    ctfExchange: Address;
    usdc: Address;
    conditionalTokens: Address;
    clobMarketManager: Address;
    kernelFactory: Address;
    ecdsaValidator: Address;
  };
  kernelVersion: '0.3.1';
}

const KERNEL_VERSION = '0.3.1' as const;

/**
 * Hosts that may use plain `http:` or `ws:`, so tests can point at local gateways. The
 * transport uses the same set to decide where it may send a credential.
 */
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const CONTRACT_FIELDS = [
  'ctfExchange',
  'usdc',
  'conditionalTokens',
  'clobMarketManager',
  'kernelFactory',
  'ecdsaValidator',
] as const;

/**
 * XO mainnet: the environment a client uses when it is given none. Plain wallets and smart
 * wallets send through XO's sponsor, and the backend serves the bridge. It is frozen.
 */
export const production: EnvironmentConfig = Object.freeze({
  name: 'mainnet',
  chainId: 3223,
  backendUrl: 'https://api-mainnet.xo.market',
  backendSocketUrl: 'https://api-mainnet.xo.market',
  orderbookUrl: 'https://orderbooks.xo.market',
  orderbookMarketWsUrl: 'wss://orderbooks.xo.market/ws/market',
  orderbookUserWsUrl: 'wss://orderbooks.xo.market/ws/user',
  sponsorUrl: 'https://sponsor.xo.market',
  bridge: true,
  rpcUrl: 'https://rpc-mainnet-2.xo.market',
  siweDomain: 'beta.xo.market',
  siweUri: 'https://beta.xo.market',
  contracts: Object.freeze({
    ctfExchange: '0x4bC5E872256D12E6017dfe466E04c867DC761B77',
    usdc: '0x80c12230ce677e6f304027a14780Edd2A829ab0c',
    conditionalTokens: '0xCcf1b2C676E2f9A13e5674be0e0DdFF6d0B13909',
    clobMarketManager: '0xE1654812Ac8896A69Efa3b6Aa71090E4b44Eb307',
    kernelFactory: '0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419',
    ecdsaValidator: '0x845ADb2C711129d4f3966735eD98a9F09fC4cE57',
  }),
  kernelVersion: KERNEL_VERSION,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks a URL field. `secure` is the TLS scheme the field requires (`https:` or
 * `wss:`). Its plain twin (`http:` or `ws:`) is allowed only for a local host.
 */
function checkUrl(
  value: unknown,
  field: string,
  secure: 'https:' | 'wss:',
): string {
  const plain = secure === 'https:' ? 'http:' : 'ws:';
  if (typeof value !== 'string') {
    throw new UserInputError(`${field} must be a valid ${secure} URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserInputError(`${field} must be a valid ${secure} URL`);
  }
  if (url.protocol === secure) {
    return value;
  }
  if (url.protocol === plain && LOCAL_HOSTS.has(url.hostname)) {
    return value;
  }
  throw new UserInputError(
    `${field} must use ${secure}, or ${plain} on localhost, 127.0.0.1 or [::1]`,
  );
}

/** A lower-case host with an optional port, as it appears in a SIWE message. */
const SIWE_DOMAIN_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/;

function checkSiweDomain(value: unknown): string {
  if (typeof value !== 'string' || !SIWE_DOMAIN_PATTERN.test(value)) {
    throw new UserInputError(
      'siweDomain must be a lower-case host with an optional port, such as app.example.com or localhost:3000',
    );
  }
  return value;
}

function checkBridge(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new UserInputError('bridge must be a boolean');
  }
  return value;
}

function checkName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UserInputError('name must be a non-empty string');
  }
  return value;
}

function checkChainId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new UserInputError('chainId must be a positive safe integer');
  }
  return value;
}

/**
 * Validates a custom config and returns a new, deep-frozen copy. The input is only
 * read, never changed, and the copy holds only the known fields.
 */
function validateCustom(input: unknown): EnvironmentConfig {
  if (!isRecord(input)) {
    throw new UserInputError(
      'environment must be an environment config object',
    );
  }
  // A `bundler` block is refused, never silently dropped, so a config written for it cannot
  // lose its gas path unnoticed. A key that is present but `undefined` is ignored.
  if (input.bundler !== undefined) {
    throw new UserInputError(
      "bundler is not supported: XO's chains send through the sponsor (sponsorUrl)",
    );
  }
  if (input.kernelVersion !== KERNEL_VERSION) {
    throw new UserInputError(`kernelVersion must be "${KERNEL_VERSION}"`);
  }
  const contractsInput = input.contracts;
  if (!isRecord(contractsInput)) {
    throw new UserInputError('contracts must be an object');
  }

  const contracts = {} as Record<(typeof CONTRACT_FIELDS)[number], Address>;
  for (const field of CONTRACT_FIELDS) {
    contracts[field] = normalizeAddress(
      contractsInput[field] as string,
      `contracts.${field}`,
    );
  }

  return Object.freeze({
    name: checkName(input.name),
    chainId: checkChainId(input.chainId),
    backendUrl: checkUrl(input.backendUrl, 'backendUrl', 'https:'),
    backendSocketUrl: checkUrl(
      input.backendSocketUrl,
      'backendSocketUrl',
      'https:',
    ),
    orderbookUrl: checkUrl(input.orderbookUrl, 'orderbookUrl', 'https:'),
    orderbookMarketWsUrl: checkUrl(
      input.orderbookMarketWsUrl,
      'orderbookMarketWsUrl',
      'wss:',
    ),
    orderbookUserWsUrl: checkUrl(
      input.orderbookUserWsUrl,
      'orderbookUserWsUrl',
      'wss:',
    ),
    ...(input.sponsorUrl === undefined
      ? {}
      : { sponsorUrl: checkUrl(input.sponsorUrl, 'sponsorUrl', 'https:') }),
    ...(input.bridge === undefined
      ? {}
      : { bridge: checkBridge(input.bridge) }),
    rpcUrl: checkUrl(input.rpcUrl, 'rpcUrl', 'https:'),
    siweDomain: checkSiweDomain(input.siweDomain),
    siweUri: checkUrl(input.siweUri, 'siweUri', 'https:'),
    contracts: Object.freeze(contracts),
    kernelVersion: KERNEL_VERSION,
  });
}

/**
 * Validates a custom config and returns a deep-frozen copy, so the caller's object is never
 * changed.
 *
 * Throws a `UserInputError` for an invalid config. The error names the field that failed. A
 * config with a `bundler` block is refused before any other check.
 */
export function resolveEnvironment(env: EnvironmentConfig): EnvironmentConfig {
  return validateCustom(env);
}
