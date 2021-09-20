import { LunaSecError } from '@lunasec/isomorphic-common';
import { GrantTypeUnion, isToken, Tokenizer } from '@lunasec/tokenizer-sdk';
import { Request } from 'express';

import { KeyService } from '../authentication';
import { SessionIdProvider } from '../authentication/types';

export class LunaSecGrantService {
  private readonly auth: KeyService;
  private readonly sessionIdProvider: SessionIdProvider | undefined;

  constructor(auth: KeyService, sessionIdProvider?: SessionIdProvider) {
    this.auth = auth;
    this.sessionIdProvider = sessionIdProvider;
  }

  private async initializeTokenizer() {
    // TODO (cthompson) as long as the node-sdk is the source of truth for authentication
    // this is ok. Once we are using an auth provider for this information, this will need to change.
    // in the future this will happen inside a lambda instead of making a request to the go server
    const authenticationToken = await this.auth.createAuthenticationJWT('application', {});
    return new Tokenizer({
      authenticationToken: authenticationToken.toString(),
    });
  }

  /**
   *   This private function handles the creating of just one grant, and is used by the public function below
   */
  private async createOneGrant(sessionId: string, token: string) {
    if (!isToken(token)) {
      throw new Error('Attempted to create a LunaSec Token Grant from a string that didnt look like a token');
    }
    const tokenizer = await this.initializeTokenizer();
    const resp = await tokenizer.createReadGrant(sessionId, token);
    if (!resp.success) {
      throw new LunaSecError({
        message: `unable to set detokenization grant for: ${token}`,
        name: 'grantCreationFailure',
        code: '500',
      });
    }
  }

  // Public create can also handle arrays for people's convenience, so it mostly deals with handling the array and passes the verifying logic to the private function above
  /**
   * Creates a grant for a token or array of tokens
   * @throws LunaSecError
   * @param sessionId The session ID of the user to create a grant for, should match whatever your sessionIdProvider in your LunaSec Config returns
   * @param tokenId The token to create a grant for
   * */
  public async create(sessionId: string, tokenOrTokens: string | string[]) {
    if (Array.isArray(tokenOrTokens)) {
      const grantPromises: Promise<void>[] = [];
      tokenOrTokens.forEach((t) => {
        grantPromises.push(this.createOneGrant(sessionId, t));
      });
      return await Promise.all(grantPromises);
    } else {
      return await this.createOneGrant(sessionId, tokenOrTokens);
    }
  }

  /**
   * This private function handles the verifying of just one grant, and is used by the public function below
   * */
  private async verifyOneGrant(sessionId: string, tokenId: string, grantType: GrantTypeUnion) {
    const authenticationToken = await this.auth.createAuthenticationJWT('application', {});

    const tokenizer = new Tokenizer({
      authenticationToken: authenticationToken.toString(),
    });

    if (tokenId === '') {
      return Promise.resolve(); // no point in verifying empty tokens, allow them to be written to the db
    }
    if (!isToken(tokenId)) {
      throw new LunaSecError({
        name: 'badToken',
        message: 'Attempted to verify a LunaSec Token Grant from a string that didnt look like a token',
        code: '400',
      });
    }
    const res = await tokenizer.verifyGrant(sessionId, tokenId, grantType);
    if (!res.success) {
      throw res.error;
    }
    if (res.valid === false) {
      throw new LunaSecError({ name: 'invalidGrant', message: 'Grant Invalid', code: '401' });
    }
    return;
  }

  // Public verify can also handle arrays for people's convenience, so it deals with handling the array and passes the verifying logic to the private function above
  /**
   * Verifies a token grant or array of token grants
   * @param sessionId
   * @param tokenOrTokens
   * @param grantType
   * @throws LunaSecError
   */
  public async verify(sessionId: string, tokenOrTokens: string | string[], grantType: GrantTypeUnion = 'store_token') {
    // Todo: dry up this array handling from above, we are doing it twice.
    if (Array.isArray(tokenOrTokens)) {
      const grantPromises: Promise<void>[] = [];
      tokenOrTokens.forEach((t) => {
        grantPromises.push(this.verifyOneGrant(sessionId, t, grantType));
      });
      return await Promise.all(grantPromises);
    } else {
      return await this.verifyOneGrant(sessionId, tokenOrTokens, grantType);
    }
  }

  // _______________ GRAPHQL HELPER METHODS ________________________-
  // Uses the sessionIdProvider configured by the user

  private async getSessionIdFromReq(req: Request): Promise<string> {
    if (!this.sessionIdProvider) {
      throw new Error(
        'Attempted to grant or verifyGrant of a token automatically without the sessionIdProvider configured, check your LunaSec Config'
      );
    }
    const sessionId = await this.sessionIdProvider(req);
    // TODO: Will also need to support the case of the user not being logged in somehow, maybe that will be a URL param and can be handled by the customer in their callback
    if (typeof sessionId !== 'string') {
      const err = new Error(
        'Session ID from the SessionIdProvider passed in LunaSecOptions did not resolve to a string'
      );
      //@ts-ignore node errors have this .code property, don't know what typescript is complaining about
      err.code = 401;
      throw err;
    }
    return sessionId;
  }

  /**
   * @throws LunaSecError
   * @param req
   * @param token
   */
  public async createWithAutomaticSessionId(req: Request, token: string | string[]) {
    return this.create(await this.getSessionIdFromReq(req), token);
  }

  /**
   * @throws LunaSecError
   * @param req
   * @param token
   * @param grantType
   */
  public async verifyWithAutomaticSessionId(req: Request, token: string | string[], grantType: GrantTypeUnion) {
    return this.verify(await this.getSessionIdFromReq(req), token, grantType);
  }
}
