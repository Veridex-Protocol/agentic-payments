import { StoredSession } from '../session/SessionStorage';

export class PaymentTokenizer {
  async tokenize(session: StoredSession): Promise<string> {
    const data = {
      keyHash: session.keyHash,
      type: 'VERIDEX_SESSION',
      limits: session.config,
    };
    return Buffer.from(JSON.stringify(data)).toString('base64');
  }
}
