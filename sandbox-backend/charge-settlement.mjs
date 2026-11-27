import {FieldValue} from '@google-cloud/firestore';
import {hash,reject,uuid} from './accounts.mjs';
import {finalBill,notification,settleWallet,usableCard} from './production-wallet.mjs';

const stamp=()=>new Date().toISOString();
const later=()=>new Date(Date.now()+60000).toISOString();

export function chargeSettlement(db,provider){
  const charges=db.collection('afe_wallet_charges');
  async function finish(ref,receipt){
    if(!['PAID','DECLINED'].includes(receipt?.state))return 'PAYMENT_PENDING';
    return db.runTransaction(async tx=>{
      const charge=(await tx.get(ref)).data();
      if(charge.state!=='CARD_PENDING')return charge.state;
      const user=db.collection('users').doc(charge.uid),account=(await tx.get(user)).data();
      if(account?.walletCharge!==ref.id)reject(409,'CARD_ORDER_MISMATCH');
      const paid=receipt.state==='PAID',state=paid?'SETTLED':'PAYMENT_REQUIRED';
      tx.update(ref,{state,nextCheckAt:FieldValue.delete(),...(receipt.transactionId && {providerTransaction:receipt.transactionId})});
      tx.update(user,{walletCharge:null,...(account.activeCharge===ref.id && {activeCharge:null}),
        ...(!paid && {unpaidCardCents:(account.unpaidCardCents || 0)+charge.costCents})});
      tx.update(user.collection('orders').doc(ref.id),{settlement:state,paidCents:paid?charge.costCents:0,outstandingCents:paid?0:charge.costCents});
      notification(tx,user,ref.id,paid?(charge.costCents?'CARD_PAID':'NO_CHARGE'):'CARD_DECLINED',{last4:charge.last4,costCents:charge.costCents});
      return state;
    });
  }
  async function reconcile(ref,item){
    if(item.state!=='CARD_PENDING')return item.state;
    if(item.costCents===0)return finish(ref,{state:'PAID'});
    let receipt;
    try{receipt=await provider.lookup(item.merchantRef,item.costCents);}catch{return 'PAYMENT_PENDING';}
    return finish(ref,receipt);
  }
  async function accept(cdr){
    const id=cdr?.authorization_reference;
    if(!uuid(id))reject(400,'FINAL_CDR_REQUIRED');
    const ref=charges.doc(id),hint=(await ref.get()).data();
    if(!hint)reject(404,'CHARGE_ORDER_NOT_FOUND');
    if(hint.funding!=='card')return (await settleWallet(db,id,cdr)) ?? 'SETTLED';
    const claim=await db.runTransaction(async tx=>{
      const charge=(await tx.get(ref)).data(),{cents,energy}=finalBill(charge,id,cdr);
      const user=db.collection('users').doc(charge.uid);
      const unique=db.collection('afe_wallet_cdrs').doc(hash(JSON.stringify([cdr.country_code,cdr.party_id,cdr.id])));
      const [account,seen,card,started]=await tx.getAll(user,unique,user.collection('cards').doc(charge.cardId),user.collection('notifications').doc(id+'-STARTED'));
      if(seen.exists || charge.cdrId){
        if(seen.data()?.attemptId!==id || charge.cdrId!==cdr.id || charge.costCents!==cents || charge.energyKwh!==energy)reject(409,'CARD_CDR_CONFLICT');
        return {prior:charge};
      }
      if(charge.state!=='ACTIVE' || account.data()?.walletCharge!==id)reject(409,'CARD_ORDER_MISMATCH');
      const linked=usableCard(card.data());
      const merchantRef=hash('afe-card-bill:'+id).slice(0,16);
      tx.create(unique,{attemptId:id,costCents:cents,createdAt:stamp()});
      if(energy>0 && !started.exists)notification(tx,user,id,'STARTED');
      tx.update(ref,{state:'CARD_PENDING',costCents:cents,energyKwh:energy,cdrId:cdr.id,merchantRef,nextCheckAt:later()});
      tx.update(user.collection('orders').doc(id),{settlement:'PAYMENT_PENDING',costCents:cents,energyKwh:energy,last4:charge.last4});
      return {linked,cents,merchantRef};
    });
    if(claim.prior)return reconcile(ref,claim.prior);
    // Exactly one transaction wins the right to submit. After uncertain delivery, only query the same reference.
    if(claim.cents===0)return finish(ref,{state:'PAID'});
    let receipt;
    try{receipt=await provider.peachDirectCharge(claim.linked.cardToken,claim.cents,claim.merchantRef,claim.linked.firstTransaction);}
    catch{return 'PAYMENT_PENDING';}
    return finish(ref,receipt);
  }
  return {accept,reconcile};
}
