// Real protection screen, typed API and React Query; transport/native/account are fixtures.
const React = require('react'), {create, act} = require('react-test-renderer');
const query = require('@tanstack/react-query'), {resolve} = require('node:path');
const {load} = require('./ledgerTestHarness.cjs');
const {deferred} = require('./walletTransferHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {conditionalFixture}=require('./conditionalFixtures.cjs');
function conditionalHarness(options = {}) {
  const h={accountId:'A',routeAccountId:'A',session:1,requests:[],reads:[],invalidations:[],options};
  const client=new query.QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  const invalidate=client.invalidateQueries.bind(client);
  client.invalidateQueries=config=>{h.invalidations.push(config?.queryKey ?? []);return invalidate(config);};
  const api=load(resolve(__dirname,'../src/features/conditional/api.ts'),{'../../services/api/client':{apiClient:{
    get:async(path,config)=>{const id=path.split('/')[2];h.reads.push({path,config});if(h.readGate)await h.readGate.promise;if(h.readFailure)throw h.readFailure;return {data:{data:conditionalFixture(h.wrongScope??id,h.options)}};},
    post:async(path,body)=>{h.requests.push({path,body});if(h.gate)await h.gate.promise;if(h.failure)throw h.failure;return {data:{data:{tradingAccountId:h.wrongScope??path.split('/')[2],groupId:'group',status:path.endsWith('/cancel')?'canceled':'active'}}};}
  }}});
  const native=Object.fromEntries(['View','Text','TextInput'].map(n=>[n,n]));native.StyleSheet={create:s=>s};
  const Screen=load(resolve(__dirname,'../src/features/conditional/ProtectionPanel.tsx'),{
    'react-native':native,'@react-navigation/native':{useIsFocused:()=>true},
    '../../features/conditional/api':api,
    '../../features/tradingAccount/TradingAccountContext':{useTradingAccount:()=>({selectedAccountId:h.accountId})},
    '../../services/api/sessionOwnership':{getSessionGeneration:()=>h.session,isCurrentSession:s=>s===h.session},
    '../../components/states/AdminDiagnosticPanel':{default:()=>null,__esModule:true},
    '../../components/common/CTAButton':{default:'CTAButton',__esModule:true}
  }).default;
  const tree=()=>React.createElement(query.QueryClientProvider,{client},React.createElement(Screen,{accountId:h.routeAccountId,assetId:'asset',positionId:options.flat?undefined:'position',domain:options.domain??'futures'}));
  h.flush=async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,25));});};
  h.start=async()=>{await act(async()=>{h.renderer=create(tree());});await h.flush();};
  h.update=async()=>{await act(async()=>h.renderer.update(tree()));await h.flush();};
  h.node=id=>h.renderer.root.findAll(n=>typeof n.type==='string'&&n.props.testID===id)[0];
  h.press=async id=>{await act(async()=>h.node(id).props.onPress());await h.flush();};
  h.button=async label=>{await act(async()=>h.renderer.root.findAll(n=>n.type==='CTAButton'&&n.props.label===label)[0].props.onPress());await h.flush();};
  h.input=async(label,value)=>{await act(async()=>h.renderer.root.findAll(n=>n.type==='TextInput'&&n.props.accessibilityLabel===label)[0].props.onChangeText(value));};
  h.text=()=>JSON.stringify(h.renderer.toJSON());
  h.close=async()=>{await act(async()=>h.renderer.unmount());client.clear();};
  h.api=api;h.client=client;return h;
}
module.exports={conditionalFixture,conditionalHarness,deferred};
