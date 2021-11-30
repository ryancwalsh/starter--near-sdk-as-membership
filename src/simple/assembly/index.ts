import { PersistentUnorderedMap, Context, u128, logging, ContractPromiseBatch } from 'near-sdk-as';
import { AccountId, assert_self, assert_single_promise_success, min, XCC_GAS } from '../../utils';

// TODO: Write tests for everything in this file. And build a frontend, too!

// https://github.com/near-examples/cross-contract-calls/blob/a589ab817835f837201f4afa48be5961d8ce5360/contracts/00.orientation/README.md or maybe instead of the amount having been sent to escrow via `transfer`, I could follow this approach: https://github.com/Learn-NEAR/NCD.L1.sample--lottery/blob/2bd11bc1092004409e32b75736f78adee821f35b/src/lottery/assembly/index.ts#L149 See also https://github.com/near/NEPs/blob/07dbc5c5dc98eb5dad47c567f93a4e5479ce5aaf/specs/Standards/FungibleToken/Core.md

type MatcherAccountIdCommitmentAmountMap = PersistentUnorderedMap<AccountId, u128>; // Maybe https://docs.near.org/docs/concepts/data-storage#persistentset would be more efficient and safer and protect against DDOS attacks that Sherif mentioned.

function getMatcherCommitmentsToRecipient(recipient: AccountId): MatcherAccountIdCommitmentAmountMap {
  return new PersistentUnorderedMap<AccountId, u128>(`commitments_to_${recipient}`); // Maybe https://docs.near.org/docs/concepts/data-storage#persistentset would be more efficient and safer and protect against DDOS attacks that Sherif mentioned.
}

export function offerMatchingFunds(recipient: AccountId): string {
  const matcher = Context.sender;
  const amount = Context.attachedDeposit;
  assert(u128.gt(amount, u128.Zero), '`attachedDeposit` must be > 0.');
  const matchersForThisRecipient = getMatcherCommitmentsToRecipient(recipient);
  //transferBetweenTwoOtherAccounts(escrow, amount); // Funds go from matcher to contractName (a.k.a. "self" or "escrow"). // Probably this line is unnecessary. If funds are sent here via attachedDeposit, are there any other required steps for them to be considered secured in this contract as escrow?
  // TODO: Probably the rest of this function should be moved to a callback.
  let total = amount;
  if (matchersForThisRecipient.contains(matcher)) {
    const existingCommitment = matchersForThisRecipient.getSome(matcher);
    total = u128.add(existingCommitment, amount);
  }
  matchersForThisRecipient.set(matcher, total);
  const result = `${matcher} is now committed to match donations to ${recipient} up to a maximum of ${total}.`;
  logging.log(result);
  return result;
}

export function getCommitments(recipient: AccountId): string {
  const matchersLog: string[] = [];
  const matchersForThisRecipient = getMatcherCommitmentsToRecipient(recipient);
  const matchers = matchersForThisRecipient.keys();
  for (let i = 0; i < matchers.length; i += 1) {
    const matcher = matchers[i];
    const existingCommitment: u128 = matchersForThisRecipient.getSome(matcher);
    const msg = `${matcher} is committed to match donations to ${recipient} up to a maximum of ${existingCommitment.toString()}.`;
    logging.log(msg);
    matchersLog.push(msg);
  }
  return matchersLog.join(' ');
}

function decreaseCommitment(recipient: AccountId, requestedAmount: u128, verb: string = 'donated'): string {
  const matcher = Context.sender;
  const matchersForThisRecipient = getMatcherCommitmentsToRecipient(recipient);
  let result: string;
  if (matchersForThisRecipient.contains(matcher)) {
    const amountAlreadyCommitted = matchersForThisRecipient.getSome(matcher); // Fails if matcher does not exist for this recipient.
    let amountToDecrease = requestedAmount;
    if (requestedAmount >= amountAlreadyCommitted) {
      amountToDecrease = amountAlreadyCommitted;
      matchersForThisRecipient.delete(matcher);
      result = `${matcher} is not matching donations to ${recipient} anymore`;
    } else {
      const newAmount = u128.sub(amountAlreadyCommitted, amountToDecrease);
      matchersForThisRecipient.set(matcher, newAmount);
      result = `${matcher} ${verb} ${amountToDecrease} and so is now only committed to match donations to ${recipient} up to a maximum of ${newAmount}.`;
    }
    transferFromEscrow(matcher, requestedAmount); // Funds go from escrow back to the matcher. // TODO: How could this contract have required pre-payment (during the original pledging of funds) of the fees that would be required for any refund transfer?
    // TODO: Should there be a callback?
  } else {
    // Fails if recipient does not exist.
    result = `${matcher} does not currently have any funds committed to ${recipient}, so funds cannot be ${verb}.`;
  }

  logging.log(result);
  return result;
}

export function rescindMatchingFunds(recipient: AccountId, requestedAmount: string): string {
  // Is `string` the correct type for `requestedAmount`?
  const requestedWithdrawalAmount = u128.fromString(requestedAmount); // or maybe https://docs.near.org/docs/tutorials/create-transactions#formatting-token-amounts
  return decreaseCommitment(recipient, requestedWithdrawalAmount, 'rescinded');
}

function onTransferComplete(): void {
  assert_self();
  assert_single_promise_success();

  logging.log('Transfer complete.');
  //TODO: Figure out what this function should do, like https://github.com/Learn-NEAR/NCD.L1.sample--thanks/blob/bfe073b572cce35f0a9748a7d4851c2cfa5f09b9/src/thanks/assembly/index.ts#L76
}

function transferFromEscrow(destinationAccount: AccountId, amount: u128): ContractPromiseBatch {
  const toDestinationAccount = ContractPromiseBatch.create(destinationAccount);
  return toDestinationAccount.transfer(amount);
}

function sendMatchingDonation(matcher: AccountId, recipient: AccountId, amount: u128, matchersForThisRecipient: MatcherAccountIdCommitmentAmountMap): string {
  const remainingCommitment: u128 = matchersForThisRecipient.getSome(matcher);
  const matchedAmount: u128 = min(amount, remainingCommitment);
  logging.log(`${matcher} will send a matching donation of ${matchedAmount} to ${recipient}.`);
  // const transferPromise = transferFromEscrow(recipient, matchedAmount);
  transferFromEscrow(recipient, matchedAmount);
  // https://github.com/Learn-NEAR/NCD.L1.sample--thanks/blob/bfe073b572cce35f0a9748a7d4851c2cfa5f09b9/src/thanks/assembly/index.ts#L56
  // transferPromise.then(escrow).function_call('onTransferComplete', '{}', u128.Zero, XCC_GAS); // TODO: Learn what this means and whether it is correct.
  decreaseCommitment(recipient, matchedAmount);
  const result = `${matcher} sent a matching donation of ${matchedAmount} to ${recipient}.`;
  return result;
}

function sendMatchingDonations(recipient: AccountId, amount: u128): string[] {
  const matchersForThisRecipient = getMatcherCommitmentsToRecipient(recipient);
  const messages: string[] = [];
  const matcherKeysForThisRecipient = matchersForThisRecipient.keys();
  for (let i = 0; i < matcherKeysForThisRecipient.length; i += 1) {
    const matcher = matcherKeysForThisRecipient[i];
    const message = sendMatchingDonation(matcher, recipient, amount, matchersForThisRecipient); // TODO: Probably this call will need to be changed to be async, which means the `message` will need to be retrieved differently.
    messages.push(message);
  }
  return messages;
}

export function donate(recipient: AccountId): string {
  const amount = Context.attachedDeposit;
  assert(amount > u128.Zero, '`attachedDeposit` must be > 0.');
  const sender = Context.sender;
  transferFromEscrow(recipient, amount); // Immediately pass it along.
  // TODO: Assert that the transfer succeeded.
  const mainDonationMessage = `${sender} donated ${amount} to ${recipient}.`;
  const matchingDonationMessages = sendMatchingDonations(recipient, amount);
  const result = `${mainDonationMessage} ${matchingDonationMessages.join(' ')}`;
  logging.log(result);
  return result;
}
