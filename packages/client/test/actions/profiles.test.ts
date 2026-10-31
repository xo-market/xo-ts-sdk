import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { fetchPublicProfile, fetchUserStats } from '../../src/actions/profiles';
import { RequestAbortedError, UserInputError } from '../../src/core/errors';
import { actionRig } from '../helpers/actionRig';
import { caught } from '../helpers/dataRig';
import { PUBLIC_USER } from '../helpers/mockAccountData';
import { wireStyleKeys } from '../helpers/modelKeys';
import { rejectedWith } from '../helpers/rejections';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

describe('fetchPublicProfile', () => {
  test('reads a public profile by username and sends no credentials', async () => {
    const r = actionRig(server, { session: true });
    const profile = await fetchPublicProfile(r.ctx, {
      username: PUBLIC_USER.username,
    });
    expect(r.backend.requests.map((q) => `${q.method} ${q.path}`)).toEqual([
      `GET /api/profiles/${PUBLIC_USER.username}`,
    ]);
    expect(r.backend.requests[0]?.authorization).toBeNull();
    expect(profile).toMatchObject({
      id: String(PUBLIC_USER.id),
      username: PUBLIC_USER.username,
      bio: 'Testing testing',
      isPrivate: false,
      socials: { x: 'xouser1330', tiktok: null },
      achievements: ['CATALYST'],
      badges: [
        { key: 'CATALYST', earned: true, revoked: false },
        { key: 'HATCHLING', earned: false, revoked: false },
      ],
      tier: 'Caller',
    });
    expect(wireStyleKeys(profile)).toEqual([]);
  });

  test('an unknown user is a 404', async () => {
    const r = actionRig(server);
    const error = await caught(() =>
      fetchPublicProfile(r.ctx, { username: 'nobody-here' }),
    );
    expect(error).toSatisfy(rejectedWith(404));
  });

  test.each([
    ['no username', {}],
    ['an empty username', { username: '' }],
    ['a username that is a number', { username: 7 }],
    ['an unknown key', { username: PUBLIC_USER.username, wallet: '0x1' }],
    ['a username with a control character', { username: 'a\nb' }],
  ])('%s is invalid_input, before any request', async (_name, request) => {
    const r = actionRig(server);
    const error = await caught(() =>
      fetchPublicProfile(r.ctx, request as never),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toMatch(/^fetchPublicProfile: /);
    expect(r.backend.requests).toEqual([]);
  });

  test('the options reach the request; an aborted signal rejects', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await fetchPublicProfile(
      r.ctx,
      { username: PUBLIC_USER.username },
      { retries: 0, timeout: 1500 },
    );
    expect(spy.mock.calls[0]?.[0].call).toEqual({
      timeoutMs: 1500,
      retries: 0,
    });
    const controller = new AbortController();
    controller.abort();
    const error = await caught(() =>
      fetchPublicProfile(
        r.ctx,
        { username: PUBLIC_USER.username },
        { signal: controller.signal },
      ),
    );
    expect(error).toBeInstanceOf(RequestAbortedError);
  });
});

describe('fetchUserStats', () => {
  test("reads a user's trading statistics by username", async () => {
    const r = actionRig(server, { session: true });
    const stats = await fetchUserStats(r.ctx, {
      username: PUBLIC_USER.username,
    });
    expect(r.backend.requests.map((q) => `${q.method} ${q.path}`)).toEqual([
      `GET /api/profiles/${PUBLIC_USER.username}/stats`,
    ]);
    expect(r.backend.requests[0]?.authorization).toBeNull();
    expect(stats).toEqual({
      pnl: '-1690.288222',
      volume: '5936.423181',
      tradedMarketCount: 52,
    });
  });

  test('an unknown user is a 404; a bad request is invalid_input', async () => {
    const r = actionRig(server);
    expect(
      await caught(() => fetchUserStats(r.ctx, { username: 'nobody-here' })),
    ).toSatisfy(rejectedWith(404));
    for (const request of [{}, { username: '' }, { user: 'x' }] as never[]) {
      const error = await caught(() => fetchUserStats(r.ctx, request));
      expect((error as UserInputError).code).toBe('invalid_input');
      expect((error as UserInputError).message).toMatch(/^fetchUserStats: /);
    }
  });

  test('the options reach the request', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await fetchUserStats(
      r.ctx,
      { username: PUBLIC_USER.username },
      { retries: 0, timeout: 1400 },
    );
    expect(spy.mock.calls[0]?.[0].call).toEqual({
      timeoutMs: 1400,
      retries: 0,
    });
  });
});
