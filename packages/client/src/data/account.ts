import type { Paginator } from '../core/paginate';
import type { CallOptions } from '../core/requestOptions';
import { usernameSegment } from './accountParams';
import {
  type AccountProfile,
  AccountProfileSchema,
  type ApiKeyInfo,
  ApiKeysSchema,
  type PublicProfile,
  PublicProfileSchema,
  type UserStats,
  UserStatsSchema,
} from './accountSchemas';
import type { DataDeps } from './internal';
import { singlePage } from './pages';

/**
 * The account itself: its profile and its API keys. Every method is a `shared` route
 * (`account:read`): it is sent with the session's backend key, and fails at once with an
 * `AuthRequiredError` when the session has neither a signer nor a key.
 */
export class AccountApi {
  /** @internal Made by `DataClient`, which owns the transport and the session. */
  constructor(private readonly deps: DataDeps) {}

  /**
   * The account's profile (`GET /users/me`): identity, wallet, points, tier and the
   * conviction-point accrual. Positions and history are not in it: see
   * `DataClient.portfolio` and `DataClient.activity`.
   */
  async me(call?: CallOptions): Promise<AccountProfile> {
    return this.deps.get('account.me', AccountProfileSchema, { call });
  }

  /**
   * The metadata of the account's API keys (`GET /auth/api-keys`, `account:read`), newest
   * first, revoked and expired ones included. One page. The key itself is never listed.
   *
   * **The backend lists at most 100 keys**, the newest 100 by creation time, revoked and
   * expired ones counting, so on an account that has made many keys an old key can be missing
   * from the list (a long-lived key given as `credentials.backend.apiKey`, for one).
   */
  apiKeys(call?: CallOptions): Paginator<ApiKeyInfo> {
    return singlePage(
      () => this.deps.get('account.apiKeys', ApiKeysSchema, { call }),
      (raw) => raw,
    );
  }
}

/** The public profiles of users. No credentials are sent. */
export class ProfilesApi {
  /** @internal Made by `DataClient`, which owns the transport and the session. */
  constructor(private readonly deps: DataDeps) {}

  /**
   * The public profile of a user by username (`GET /profiles/:username`): display name, bio,
   * picture, badges, socials and conviction points. A private profile has the bio, socials
   * and badges `null`.
   *
   * @throws {UserInputError} For an empty or malformed username, before any request.
   * @throws {RequestRejectedError} Status 404, when there is no such user.
   */
  async get(username: string, call?: CallOptions): Promise<PublicProfile> {
    return this.deps.get('profiles.get', PublicProfileSchema, {
      params: { username: usernameSegment(username) },
      call,
    });
  }

  /**
   * A user's trading statistics (`GET /profiles/:username/stats`): PnL, volume and markets
   * traded.
   *
   * @throws {UserInputError} For an empty or malformed username, before any request.
   * @throws {RequestRejectedError} Status 404, when there is no such user.
   */
  async stats(username: string, call?: CallOptions): Promise<UserStats> {
    return this.deps.get('profiles.stats', UserStatsSchema, {
      params: { username: usernameSegment(username) },
      call,
    });
  }
}
