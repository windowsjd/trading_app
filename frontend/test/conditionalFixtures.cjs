function conditionalFixture(accountId = 'A', options = {}) {
  const enabled = options.enabled !== false, tradable = enabled && options.mode !== 'DISABLED';
  const group = {id:'group',domain:options.domain ?? 'futures',assetId:'asset',positionId:'position',parentOrderId:options.holding?'parent':null,direction:options.direction ?? 'long',status:options.holding?'holding':options.complete?'completed':'active',currencyCode:'USD',remainingQuantity:'100',createdAt:'2026-10-08T00:00:00Z',endedAt:null,terminalReason:null,
    legs: ['stop_loss','take_profit'].map((kind,i)=>({id:kind,kind,triggerPrice:i?'123456789.12345678':'90000.00000001',childOrderType:i?'limit':'market',childLimitPrice:i?'123456799.12345678':null,state:options.holding?'holding':i?'triggered':'armed'})),
    children:[{id:'child',legId:'take_profit',status:'pending',quantity:'100',orderId:'order',futuresExecutionId:null,triggeredAt:'2026-10-08T00:00:00Z',terminalReason:null,triggerEvidence:{price:'123456789.12345678',sourceName:'binance_trade',effectiveAt:'2026-10-08T00:00:00Z',capturedAt:'2026-10-08T00:00:00Z'}}]};
  if(options.complete){group.remainingQuantity=null;group.endedAt='2026-10-08T00:01:00Z';group.terminalReason='position_closed';group.legs.forEach(l=>l.state=l.kind==='take_profit'?'completed':'canceled');group.children[0].status='filled';}
  return {tradingAccountId:accountId,capabilities:{enabled,canCreateSpot:enabled,canCreateFutures:tradable,canUseSpotLimit:true,canCancel:true},groups:options.active||options.holding||options.complete?[group]:[],pagination:{limit:30,offset:0,total:options.active||options.holding||options.complete?1:0,returned:options.active||options.holding||options.complete?1:0,nextOffset:null,hasNext:false}};
}
module.exports={conditionalFixture};
