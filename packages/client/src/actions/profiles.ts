import { z } from 'zod';
import type { ActionContext } from '../clients/context';
import {
  makeErrorGuard,
  RateLimitError,
  RequestAbortedError,
  RequestRejectedError,
  SigningError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../core/errors';
import {
  parseRequestOptions,
  type RequestOptions,
} from '../core/requestOptions';
import {
  type PublicProfile,
  toPublicProfile,
  toUserStats,
  type UserStats,
} from '../models/account';
import { fields, parseInput } from './internal';

// The public profiles of XO's users, which anyone can read by username.

/** What {@link PublicClient.fetchPublicProfile} and {@link PublicClient.fetchUserStats} take. */
export type UsernameRequest = {
  /** The user's unique name on XO. */
  username: string;
};

const UsernameSchema = z.strictObject({ username: fields.username() });

/** The error union of {@link PublicClient.fetchPublicProfile}. */
export type FetchPublicProfileError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchPublicProfileError}. */
export const FetchPublicProfileError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the public profile of a user: display name, picture, badges, social handles and
 * conviction points. A private profile leaves its bio, socials and badges `null`. No
 * credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchPublicProfile(
  ctx: ActionContext,
  request: UsernameRequest,
  options?: RequestOptions,
): Promise<PublicProfile> {
  const input = parseInput('fetchPublicProfile', request, UsernameSchema);
  const call = parseRequestOptions(options);
  return toPublicProfile(await ctx.data.profiles.get(input.username, call));
}

/**
 * The error union of {@link PublicClient.fetchUserStats}. On a signed-in client that reads its own account,
 * also the sign-in it makes when its API key is refused (`SigningError`) and `client_closed`
 * once it is closed.
 */
export type FetchUserStatsError =
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link FetchUserStatsError}. */
export const FetchUserStatsError = makeErrorGuard(
  UserInputError,
  SigningError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
  XoError,
);

/**
 * Reads the trading statistics of any user by username: profit and loss, volume and the
 * number of markets traded. No credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchUserStats(
  ctx: ActionContext,
  request: UsernameRequest,
  options?: RequestOptions,
): Promise<UserStats> {
  const input = parseInput('fetchUserStats', request, UsernameSchema);
  const call = parseRequestOptions(options);
  return toUserStats(await ctx.data.profiles.stats(input.username, call));
}
