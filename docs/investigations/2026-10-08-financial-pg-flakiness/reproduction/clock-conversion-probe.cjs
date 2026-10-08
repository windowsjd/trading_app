require('/home/nayuta/projects/trading-app/backend/node_modules/tsx/dist/cjs/index.cjs');
const {PrismaClient}=require('/home/nayuta/projects/trading-app/backend/src/generated/prisma/client.ts');
const {PrismaPg}=require('/home/nayuta/projects/trading-app/backend/node_modules/@prisma/adapter-pg');
const {Client}=require('/home/nayuta/projects/trading-app/backend/node_modules/pg');
(async()=>{
 const url='postgresql://trading_app@127.0.0.1:55559/finance_f1';const p=new PrismaClient({adapter:new PrismaPg({connectionString:url})}); const c=new Client({connectionString:url});await c.connect();
 for(let i=0;i<12;i++){
 const before=new Date();const [prisma]=await p.$queryRawUnsafe('WITH t AS MATERIALIZED (SELECT clock_timestamp() AS t) SELECT t AS now, t::text AS text, extract(epoch FROM t)::text AS epoch FROM t');const after=new Date();
 const pg=(await c.query('WITH t AS MATERIALIZED (SELECT clock_timestamp() AS t) SELECT t AS now, t::text AS text, extract(epoch FROM t)::text AS epoch FROM t')).rows[0];
 console.log(JSON.stringify({before,prisma,after,pg})); await new Promise(r=>setTimeout(r,5));
 }
 await p.$disconnect(); await c.end();
})().catch(e=>{console.error(e);process.exitCode=1;});
