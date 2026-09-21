import { PlatformClient, type PlatformClientConfig, type SponsorshipQuote } from '@veridex/sdk/platform';
import type { SubmitSignedActionRequest } from '@veridex/sdk';

export interface SponsoredExecutionResult {
  quote: SponsorshipQuote;
  executionId: string;
  reservationCount: number;
  submission: { success: boolean; transactionHash?: string; sequence?: string; actualSponsoredCost?: string };
}

export class PlatformPaymentsAdapter {
  readonly client: PlatformClient;
  constructor(config: PlatformClientConfig) { this.client = new PlatformClient(config); }

  async sponsorExecution(action: SubmitSignedActionRequest, idempotencyKey: string): Promise<SponsoredExecutionResult> {
    const { quote } = await this.client.quote(action, `${idempotencyKey}:quote`);
    const executionId = `exec_${crypto.randomUUID()}`;
    const reservation = await this.client.reserve(quote, executionId, `${idempotencyKey}:reserve`);
    const submission = await this.client.submitSponsored(action, executionId);
    return { quote, executionId, reservationCount: reservation.reservations.length, submission };
  }

  listExecutions(limit?: number) { return this.client.listExecutions(limit); }
  listReconciliationIssues() { return this.client.listReconciliationIssues(); }
  getExecution(executionId: string) { return this.client.getExecution(executionId); }
  cancelExecution(executionId: string, reason?: string) { return this.client.cancelExecution(executionId, reason); }
}
