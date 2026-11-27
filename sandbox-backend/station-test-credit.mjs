import {reject} from './accounts.mjs';
import {rivoniaSite as pilotSite,rivoniaEvses as pilotEvses,isRivoniaConnector as pilotSiteMatches} from './charger-connection.mjs';
export {pilotSite,pilotSiteMatches};

export const pilotRef = 'afe-rivonia-internal-202611';
export const pilotNote = 'AFE 自营场站首充测试额度';
export const pilotAmount = 100000;

export function pilotCreditView(driver,uid) {
  const credit=driver?.stationTestCredit;
  if (!credit) return null;
  if (credit.uid!==uid || credit.reference!==pilotRef || credit.issuedCents!==pilotAmount ||
      !Number.isSafeInteger(credit.remainingCents) || credit.remainingCents<0 || credit.remainingCents>credit.issuedCents)
    reject(409,'STATION_CREDIT_REVIEW_REQUIRED');
  return {reference:pilotRef,stationName:'382 Rivonia',scope:pilotSite,evseUids:pilotEvses,
    note:pilotNote,remainingCents:credit.remainingCents,issuedCents:credit.issuedCents};
}

export function pilotBudget(driver,uid,target) {
  const credit=pilotCreditView(driver,uid);
  if (!credit || !pilotSiteMatches(target)) reject(403,'STATION_CREDIT_NOT_ELIGIBLE');
  return credit.remainingCents;
}

export function settlePilotCredit(tx,user,driver,charge,id,costCents,energyKwh) {
  const available=pilotBudget(driver,charge.uid,charge.target);
  const fundedCents=Math.min(available,costCents), remainingCents=available-fundedCents;
  const operatorReviewCents=costCents-fundedCents;
  const details={creditReference:pilotRef,fundedCents,operatorReviewCents};
  tx.update(user,{'stationTestCredit.remainingCents':remainingCents});
  tx.create(user.collection('walletLedger').doc('charge-'+id),{kind:'TEST_CREDIT_CHARGE',reference:id,
    ...details,deltaCents:0,creditDeltaCents:-fundedCents,creditBalanceCents:remainingCents,
    costCents,energyKwh,note:pilotNote,createdAt:new Date().toISOString()});
  return details;
}
