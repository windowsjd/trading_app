// Transport-only browser fixture. Real screens/commands/guide remain mounted.
import { permissionsFromQuests, questPayload } from '../questFixtures';
import { assets as cryptoAssets, apiClient as chartClient } from './tradingMocks';
import { futuresFixture, futuresCandlesFixture } from '../futuresFixtures.cjs';
import { conditionalFixture } from '../conditionalFixtures.cjs';
export function tradingQuestTransport(response, committedAt, accountId, level) {
  const progress = questPayload(level, accountId), orders = new Map(), holdings = new Map();
  const stock = (id, us) => ({ ...cryptoAssets[0], id, symbol: us ? 'TCUS' : '000001', name: us ? '미국 실습 주식' : '한국 실습 주식', assetType: us ? 'us_stock' : 'domestic_stock', market: us ? 'NASDAQ' : 'KRX', priceCurrency: us ? 'USD' : 'KRW', settlementCurrency: us ? 'USD' : 'KRW', marketStatus: 'open', price: { ...cryptoAssets[0].price, currentPrice:'100', priceCurrency:us?'USD':'KRW' } });
  const assets = [{ ...cryptoAssets[0], price: { ...cryptoAssets[0].price, currentPrice:'100' } },stock('KR',false),stock('US',true)];
  const spot = assets[0];let protection=null, position=null, quote=null, serial=0;
  // Independent stop-loss/take-profit settings (QUEST 04 since 2026-10-15).
  const settings=[];
  const sellCapabilities={enabled:true,condition:{enabled:true,canCreate:true,canUseLimit:true},protection:{enabled:true,canCreate:true,canUseLimit:false},canCancel:true,markets:['KRX','CRYPTO_SPOT'],maxLivePerAccount:30};
  const page=rows=>({offset:0,limit:100,returned:rows.length,total:rows.length,nextOffset:null});
  const complete=(index,step,id)=>{const row=progress.quests[index];if(!row.steps[step].completed)row.steps[step]={...row.steps[step],completed:true,completedAt:committedAt(),referenceId:id};row.completedStepCount=row.steps.filter(s=>s.completed).length;row.status=row.completedStepCount===row.totalStepCount?'completed':'in_progress';};
  const snapshot=()=>{
    const done=i=>progress.quests[i].status==='completed';
    progress.learningAccess={exchange:true,transfer:done(0),cryptoMarketBuy:done(1),spotProtection:done(2),cryptoLimitBuy:done(4),allTrading:done(5)};
    // Staged permissions (B차): an open practice position holds its direction.
    const openDirection=position&&Number(position.quantity)>0?position.direction:null;
    progress.learningPermissions=permissionsFromQuests(progress.quests,{long:openDirection==='long',short:openDirection==='short'});
    return response(structuredClone(progress));
  };
  const hold=asset=>({ ...asset,assetId:asset.id,positionId:`position-${asset.id}`,quantity:'1.00000000',availableQuantity:'1.00000000',reservedQuantity:'0',averageCost:'100',currencyCode:asset.settlementCurrency,
    valuation:{state:'available',price:'100',currentPrice:'100',marketValue:'100',marketValueKrw:'135000',costBasis:'100',unrealizedPnl:'-0.1',unrealizedPnlKrw:'-135',returnRate:'-0.1',unrealizedReturnRate:'-0.1',evaluatedAt:committedAt()}});
  if(level>=3&&level<5)holdings.set(spot.id,hold(spot));
  if(level>=3)progress.practice.spotAssetId=spot.id;
  return {
    progress:snapshot,
    async get(path,config){
    // Contract chart at the requested 봉 시간 (market data, not account-scoped).
    if (path.startsWith('/futures/instruments/') && path.includes('/candles')) return { data: { success: true, data: futuresCandlesFixture(decodeURIComponent(path.split('/')[3]), Date.now(), new URLSearchParams(path.split('?')[1] ?? '').get('interval') ?? '4h') } };
      const url=new URL(path,'https://fixture.invalid'),parts=url.pathname.split('/');
      if(parts[1]==='assets'){
        if(!parts[2]){const rows=assets.filter(a=>a.assetType===(config?.params?.assetType??url.searchParams.get('assetType')??'crypto'));return response({assets:rows,pagination:page(rows),sortSnapshot:'quests'});}
        const asset=assets.find(a=>a.id===decodeURIComponent(parts[2]));
        if(asset&&parts.length===3)return response({asset});
        if(asset&&parts[3]==='candles')return chartClient.get(path.replace(`/assets/${asset.id}`,`/assets/BTC`),config);
      }
      if(!path.startsWith(`/trading-accounts/${accountId}/`))return undefined;
      if(path.includes('/futures/')){
        const f=futuresFixture(accountId,{position:!!position,direction:position?.direction,leverage:position?.leverage??2});
        if(position){f.positions.positions[0]={...f.positions.positions[0],id:position.id,quantity:position.quantity};}
        if(path.endsWith('/instruments'))return response(f.catalog);
        if(path.endsWith('/positions'))return response(f.positions);
        if(path.includes('/limit-orders'))return response({tradingAccountId:accountId,orders:[],pagination:page([])});
        if(path.includes('/executions'))return response({...f.executions,executions:[],pagination:page([])});
        if(path.includes('/liquidations'))return response({...f.liquidations,liquidations:[],pagination:page([])});
        return response(f.final);
      }
      if(path.endsWith('/positions')){const rows=[...holdings.values()];return response({tradingAccountId:accountId,state:'available',positions:rows,pagination:page(rows)});}
      if(path.includes('/orders/'))return response({tradingAccountId:accountId,order:orders.get(parts[4])});
      if(path.endsWith('/orders')){const rows=[...orders.values()].filter(o=>o.status==='submitted');return response({tradingAccountId:accountId,state:'available',orders:rows,pagination:page(rows)});}
      if(path.includes('/protections')){const result=conditionalFixture(accountId,{domain:'spot',enabled:true});result.groups=protection?[protection]:[];result.pagination=page(result.groups);return response(result);}
      if(path.endsWith('/conditional-sell-orders')){const state=config?.params?.state;const rows=settings.filter(r=>state==='ended'?r.state!=='watching':r.state==='watching');return response({tradingAccountId:accountId,capabilities:sellCapabilities,conditionalOrders:rows,pagination:page(rows)});}
      return undefined;
    },
    async post(path,body){
      if(!path.startsWith(`/trading-accounts/${accountId}/`))return undefined;
      if(path.endsWith('/quests/acknowledgements')){
        const order=orders.get(body.orderId);if(!order)throw Error('No committed practice order');
        if(body.stepId==='holdings_reviewed'&&order.status==='executed')complete(2,1,body.orderId);
        else if(body.stepId==='limit_result_reviewed'&&['canceled','executed'].includes(order.status))complete(5,1,body.orderId);
        else throw Error('Terminal financial result required');return snapshot();
      }
      if(path.endsWith('/orders/quote')){
        const asset=assets.find(a=>a.id===body.assetId);quote={...body,orderType:body.orderType??'market',asset,quoteId:`q-${++serial}`,tradingAccountId:accountId,quantity:body.quantity??String(Number(body.amount)/Number(body.limitPrice??100)),expiresAt:new Date(Date.now()+60000).toISOString(),price:'100',currencyCode:asset.settlementCurrency,grossAmount:body.amount??'100',feeAmount:'0.1',netAmount:'100.1',state:'available'};return response(quote);
      }
      if(path.endsWith('/orders')){
        const asset=assets.find(a=>a.id===body.assetId),id=`order-${++serial}`,at=committedAt();
        const order={...quote,...body,orderId:id,asset,tradingAccountId:accountId,status:body.orderType==='limit'?'submitted':'executed',submittedAt:at,executedAt:body.orderType==='limit'?null:at,executedPrice:body.orderType==='limit'?null:'100',reservedAmount:body.orderType==='limit'?'100.1':null,reservationReleasedAt:null};orders.set(id,order);
        if(body.orderType==='limit'){complete(5,0,id);progress.practice.limitAssetId=asset.id;}
        else if(body.side==='sell'){holdings.delete(asset.id);complete(4,0,id);for(const row of settings)if(row.assetId===asset.id&&row.state==='watching')Object.assign(row,{state:'canceled',status:'canceled',terminalReason:'position_closed',endedAt:at});}
        else {holdings.set(asset.id,hold(asset));complete(asset.assetType==='crypto'?2:asset.assetType==='us_stock'?7:6,0,id);if(asset.assetType==='crypto')progress.practice.spotAssetId=asset.id;}
        return response({tradingAccountId:accountId,order,execution:{state:order.status},executionPolicy:{autoExecutionEnabled:false,mode:'reservation_only'}});
      }
      if(/\/orders\/[^/]+\/cancel$/.test(path)){const order=orders.get(path.split('/')[4]);order.status='canceled';order.cancelReason='user_canceled';order.reservationReleasedAt=committedAt();return response({tradingAccountId:accountId,order});}
      if(path.endsWith('/protections')){const id=`group-${++serial}`;protection={id,domain:'spot',assetId:body.assetId,positionId:body.positionId,parentOrderId:null,direction:'long',status:'active',currencyCode:'USD',remainingQuantity:'1',createdAt:committedAt(),endedAt:null,terminalReason:null,legs:body.legs.map((l,i)=>({...l,id:`leg-${i}`,state:'armed'})),children:[]};complete(3,0,id);return response({tradingAccountId:accountId,groupId:id,status:'active'});}
      if(/\/protections\/[^/]+\/cancel$/.test(path)){protection=null;return response({tradingAccountId:accountId,groupId:'group',status:'canceled'});}
      if(path.endsWith('/conditional-sell-orders')&&body.kind==='protection'){
        const asset=assets.find(a=>a.id===body.assetId),at=committedAt();
        const rows=[['stop_loss',body.stopLoss],['take_profit',body.takeProfit]].filter(leg=>leg[1]).map(([kind,leg])=>({id:`setting-${++serial}`,assetId:asset.id,
          asset:{id:asset.id,symbol:asset.symbol,name:asset.name,market:asset.market,assetType:asset.assetType},side:'sell',kind,positionId:`position-${asset.id}`,
          triggerCondition:kind==='stop_loss'?'at_or_below':'at_or_above',triggerPrice:leg.triggerPrice,executionType:'market',limitPrice:null,quantity:leg.quantity,
          currencyCode:asset.settlementCurrency,status:'watching',state:'watching',position:null,executionAvailableQuantity:null,quantityLimited:false,trigger:null,order:null,
          attemptCount:0,lastAttemptAt:null,failureCode:null,terminalReason:null,createdAt:at,endedAt:null,updatedAt:at}));
        settings.push(...rows);complete(3,0,rows[0].id);
        return response({tradingAccountId:accountId,conditionalOrders:rows,duplicate:false});
      }
      if(path.endsWith('/futures/execute')){
        const id=body.positionId??`lifetime-${++serial}`,index=body.direction==='short'?9:8;
        if(body.operation==='open'){position={id,direction:body.direction,leverage:body.leverage,quantity:body.quantity};complete(index,0,`open-${id}`);progress.practice[body.direction==='short'?'shortPositionId':'longPositionId']=id;}
        else if(body.operation==='close'){complete(index,1,`close-${id}`);position=null;}
        return response({tradingAccountId:accountId,commandId:`command-${++serial}`,execution:{positionId:id,operation:body.operation,direction:body.direction,leverage:body.leverage,feeAmount:'0.1',positionAfter:{quantity:position?.quantity??'0.00000000'}}});
      }
      return undefined;
    },
  };
}
