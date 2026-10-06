import { bytesToHex, concatBytes, hexOfLength, utf8ToBytes } from './bytes';
import { signBytes, verifyBytes } from './ed25519';

export const PROPOSAL_DOMAIN = 'AGENT_PROPOSAL_V1';

export function proposalMessage(actionHashHex: string): Uint8Array {
  return concatBytes(utf8ToBytes(PROPOSAL_DOMAIN), hexOfLength(actionHashHex, 32, 'actionHash'));
}

export function signProposal(actionHashHex: string, agentSecretKey: Uint8Array): string {
  return bytesToHex(signBytes(proposalMessage(actionHashHex), agentSecretKey));
}

export function verifyProposal(actionHashHex: string, signatureHex: string, agentPublicKeyHex: string): boolean {
  try {
    return verifyBytes(
      hexOfLength(signatureHex, 64, 'signature'),
      proposalMessage(actionHashHex),
      hexOfLength(agentPublicKeyHex, 32, 'agentPublicKey'),
    );
  } catch {
    return false;
  }
}
