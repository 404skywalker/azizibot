'use strict';
const https     = require('https');
const fs        = require('fs');
const WebSocket = require('ws');

// ─── Config ──────────────────────────────────────────────────────────────────
const POLY_KEY      = process.env.POLY_KEY      || '';
const BZ_KEY        = process.env.BZ_KEY        || '';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const APP_ID        = '1493671812247322624';

const TOP_GAPPERS_WH = 'https://discord.com/api/webhooks/1493250562689597623/57UTSPu2KfLmYNBRVPvPQIa4cSfCQA8wVcqB5d0J8cWYaJf5hlsm1EuRkQ3lolChTNh3';
// All NHOD, PR, and SEC alerts route here. Swapped from #alerts-testing to
// #Main-chat 2026-05-14 per user directive.
const MAIN_CHAT_WH   = 'https://discord.com/api/webhooks/1504535425535049738/MbDW1k1ESVMoIRokvaJ6Fg76WhkiSh8K46AHCpZi042jNjGkUn_Y6ybU0mOXZCPMU53w';
// (Previous alerts-testing webhook, kept commented out for rollback if needed)
// const MAIN_CHAT_WH = 'https://discord.com/api/webhooks/1504111128106631359/W9Ky7814ojPziIuN6loeaNgu6l8aFzUMlMtrj8vsf4egXWfiBKFv0sNKu8VO9cclmRKD';
// Halt + resume alerts fan out to BOTH the dedicated #halt-alerts channel
// AND the main chat for visibility. Add/remove URLs to change broadcast.
// Env override HALT_ALERTS_WH replaces the entire list (comma-separated).
const HALT_ALERT_WHS = (process.env.HALT_ALERTS_WH || [
  // #halt-alerts (dedicated channel)
  'https://discord.com/api/webhooks/1504534490821689374/RStoJri7X5g5RTth-2TCEFSIyiyXvXnjx29YbGAn_Bp0tc-DzJ7qADmYI8qTpTChnIXE',
  // main chat (broadcast for visibility)
  'https://discord.com/api/webhooks/1504535425535049738/MbDW1k1ESVMoIRokvaJ6Fg76WhkiSh8K46AHCpZi042jNjGkUn_Y6ybU0mOXZCPMU53w',
].join(',')).split(',').map(s=>s.trim()).filter(Boolean);

// ─── Session tiers ────────────────────────────────────────────────────────────
//
//  EARLY-PRE  4:00–7:00 AM   ≥10% gain   vol = 0   (day.v is near-zero before open)
//  LATE-PRE   7:00–9:30 AM   ≥20% gain   vol = 0   (still pre-market, vol is thin)
//  MKT        9:30AM–4:00PM  ≥10% gain   vol ≥ 5M
//  AH         4:00–8:00 PM   ≥10% gain   vol = 0
//
//  Vol is ONLY enforced during regular market hours (MKT).
//  Pre-market % gain IS the quality filter — a stock up 20%+ pre-market is real.
//
//  dayWatchlist: any ticker qualifying 4AM–4PM is locked in all day.
//  Watchlist-only tickers skip session gates — monitored for bounces/PRs/filings.

function getTier(etMin) {
  if(etMin>=240&&etMin<570)  return {name:'PRE',       minChg:10, minVol:50000};
  if(etMin>=570&&etMin<960)  return {name:'MKT',       minChg:10, minVol:5_000_000};
  if(etMin>=960&&etMin<1200) return {name:"AH", minChg:10, minVol:500000};
  return null; // no alerts after 8PM
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getET() {
  const p = new Intl.DateTimeFormat('en-US',{
    timeZone:'America/New_York',hour:'numeric',minute:'numeric',second:'numeric',hour12:false
  }).formatToParts(new Date());
  const h  = parseInt(p.find(x=>x.type==='hour').value);
  const m  = parseInt(p.find(x=>x.type==='minute').value);
  const s  = parseInt(p.find(x=>x.type==='second').value);
  const hh = h===24?0:h;
  const etMin   = hh*60+m;
  const timeStr = `${String(hh).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  const sess    = etMin>=240&&etMin<570?'PRE':etMin>=570&&etMin<960?'MKT':etMin>=960&&etMin<1200?'AH':'CLOSED';
  return {hh,m,s,etMin,timeStr,sess};
}

// ─── Market day check (weekends + US holidays) ───────────────────────────────
function isMarketDay() {
  const now = new Date();
  const et  = new Date(now.toLocaleString('en-US',{timeZone:'America/New_York'}));
  const dow = et.getDay(); // 0=Sun 6=Sat
  if(dow===0||dow===6) return false;
  const y=et.getFullYear(), m=et.getMonth()+1, d=et.getDate();

  function nthWeekday(yr,mo,wd,n){
    const first=new Date(yr,mo-1,1);
    return 1+((wd-first.getDay()+7)%7)+(n-1)*7;
  }
  function lastWeekday(yr,mo,wd){
    const last=new Date(yr,mo,0);
    return last.getDate()-((last.getDay()-wd+7)%7);
  }
  function obs(yr,mo,dy){
    const w=new Date(yr,mo-1,dy).getDay();
    if(w===6) return {m:mo,d:dy-1};
    if(w===0) return {m:mo,d:dy+1};
    return {m:mo,d:dy};
  }
  function easter(yr){
    const a=yr%19,b=Math.floor(yr/100),c=yr%100,
          dv=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),
          g=Math.floor((b-f+1)/3),h=(19*a+b-dv-g+15)%30,
          i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,
          mm=Math.floor((a+11*h+22*l)/451),
          mo=Math.floor((h+l-7*mm+114)/31),
          dy=((h+l-7*mm+114)%31)+1;
    return {m:mo,d:dy};
  }

  const ea=easter(y);
  const gf=new Date(y,ea.m-1,ea.d-2); // Good Friday

  const holidays=[
    obs(y,1,1),                              // New Year's Day
    {m:1,  d:nthWeekday(y,1,1,3)},           // MLK Day
    {m:2,  d:nthWeekday(y,2,1,3)},           // Presidents Day
    {m:gf.getMonth()+1, d:gf.getDate()},     // Good Friday
    {m:5,  d:lastWeekday(y,5,1)},            // Memorial Day
    obs(y,6,19),                             // Juneteenth
    obs(y,7,4),                              // Independence Day
    {m:9,  d:nthWeekday(y,9,1,1)},           // Labor Day
    {m:11, d:nthWeekday(y,11,4,4)},          // Thanksgiving
    obs(y,12,25),                            // Christmas
  ];

  if(holidays.some(h=>h.m===m&&h.d===d)){
    console.log(`[Market] Holiday — no alerts today`);
    return false;
  }
  return true;
}

function isActive()  { return isMarketDay() && !!getTier(getET().etMin); }
function sleep(ms)   { return new Promise(r=>setTimeout(r,ms)); }
function fmtN(n)     { if(!n||isNaN(n))return'--'; if(n>=1e9)return(n/1e9).toFixed(2)+'B'; if(n>=1e6)return(n/1e6).toFixed(2)+'M'; if(n>=1e3)return(n/1e3).toFixed(1)+'K'; return String(n); }
// NuntioBot-style numeric format: "5.7 M" not "5.70M" — 1 decimal, space before unit.
function fmtNS(n)    { if(!n||n<=0)return'--'; if(n>=1e9)return(n/1e9).toFixed(1)+' B'; if(n>=1e6)return(n/1e6).toFixed(1)+' M'; if(n>=1e3)return(n/1e3).toFixed(1)+' K'; return String(n); }
// Age string for bullet lines: "14 minutes ago" / "3 hours ago"
function fmtAge(ms)  { if(ms<60000)return`${Math.round(ms/1000)} seconds ago`; if(ms<3600000)return`${Math.round(ms/60000)} minutes ago`; if(ms<86400000)return`${Math.round(ms/3600000)} hours ago`; return`${Math.round(ms/86400000)} days ago`; }
function fmtRVol(r)  { if(!r||isNaN(r)||r===0)return'--'; if(r>=1000)return Math.round(r).toLocaleString()+'x'; if(r>=10)return r.toFixed(0)+'x'; return r.toFixed(1)+'x'; }
function priceFlag(p){
  if(p<0.50)return'<$.50c';
  if(p<1)return'<$1';
  if(p<2)return'<$2';
  if(p<3)return'<$3';   // confirmed POAS @ ~$2.something → <$3
  if(p<4)return'<$4';   // confirmed MOBX @ ~$3.something → <$4
  if(p<5)return'<$5';
  if(p<10)return'<$10';
  // Above $10: ladder inferred from PCT (image 1) @ ~$11 → <$12.
  // Best guess until more high-price samples land: $2 increments to $20, $5 to $50, $10 above.
  if(p<20)return`<$${Math.floor(p/2)*2+2}`;
  if(p<50)return`<$${Math.floor(p/5)*5+5}`;
  return`<$${Math.floor(p/10)*10+10}`;
}
function countryFlag(country){
  if(!country) return'🇺🇸';
  const c=country.toUpperCase();
  const map={
    'US':'🇺🇸','UNITED STATES':'🇺🇸',
    'CN':'🇨🇳','CHINA':'🇨🇳','HK':'🇭🇰','HONG KONG':'🇭🇰',
    'IL':'🇮🇱','ISRAEL':'🇮🇱',
    'GB':'🇬🇧','UK':'🇬🇧','UNITED KINGDOM':'🇬🇧',
    'CA':'🇨🇦','CANADA':'🇨🇦',
    'AU':'🇦🇺','AUSTRALIA':'🇦🇺',
    'DE':'🇩🇪','GERMANY':'🇩🇪',
    'FR':'🇫🇷','FRANCE':'🇫🇷',
    'JP':'🇯🇵','JAPAN':'🇯🇵',
    'KR':'🇰🇷','SOUTH KOREA':'🇰🇷',
    'IN':'🇮🇳','INDIA':'🇮🇳',
    'BR':'🇧🇷','BRAZIL':'🇧🇷',
    'SG':'🇸🇬','SINGAPORE':'🇸🇬',
    'NL':'🇳🇱','NETHERLANDS':'🇳🇱',
    'SE':'🇸🇪','SWEDEN':'🇸🇪',
    'CH':'🇨🇭','SWITZERLAND':'🇨🇭',
    'IE':'🇮🇪','IRELAND':'🇮🇪',
    'ZA':'🇿🇦','SOUTH AFRICA':'🇿🇦',
    'MX':'🇲🇽','MEXICO':'🇲🇽',
    'RU':'🇷🇺','RUSSIA':'🇷🇺',
    'TW':'🇹🇼','TAIWAN':'🇹🇼',
    'NO':'🇳🇴','NORWAY':'🇳🇴',
    'DK':'🇩🇰','DENMARK':'🇩🇰',
    'FI':'🇫🇮','FINLAND':'🇫🇮',
    'NZ':'🇳🇿','NEW ZEALAND':'🇳🇿',
    'GR':'🇬🇷','GREECE':'🇬🇷',
    'PT':'🇵🇹','PORTUGAL':'🇵🇹',
    'ES':'🇪🇸','SPAIN':'🇪🇸',
    'IT':'🇮🇹','ITALY':'🇮🇹',
    'BE':'🇧🇪','BELGIUM':'🇧🇪',
    'CY':'🇨🇾','CYPRUS':'🇨🇾',
    'BM':'🇧🇲','BERMUDA':'🇧🇲',
    'KY':'🇰🇾','CAYMAN ISLANDS':'🇰🇾',
    'PA':'🇵🇦','PANAMA':'🇵🇦',
    'MH':'🇲🇭','MARSHALL ISLANDS':'🇲🇭',
  };
  return map[c]||'🇺🇸';
}

// ─── Foreign ticker overrides ────────────────────────────────────────────────
// FMP and Polygon both have data quality issues with ADRs — they often return
// `country: "US"` for Chinese, Israeli, etc. companies listed on US exchanges.
// This manual map is checked FIRST in flag(), highest confidence.
// To add: TICKER: 'CC' where CC is the ISO-3166-1 alpha-2 country code.
// To extend in production without redeploying, move this to foreign_tickers.txt
// (similar to watchlist.txt) — happy to wire that up if the list grows large.
const FOREIGN_TICKER_OVERRIDES = {
  // China
  'BABA':'CN','BIDU':'CN','NIO':'CN','XPEV':'CN','LI':'CN','JD':'CN','PDD':'CN',
  'NTES':'CN','IQ':'CN','BILI':'CN','TAL':'CN','EDU':'CN','TIGR':'CN','FUTU':'CN',
  'MOMO':'CN','HUYA':'CN','VIPS':'CN','TME':'CN','LU':'CN','LX':'CN','FINV':'CN',
  'YRD':'CN','MNSO':'CN','DAO':'CN','ATAT':'CN','GOTU':'CN','ZH':'CN','VNET':'CN',
  'KC':'CN','BZUN':'CN','NOAH':'CN','JKS':'CN','CSIQ':'CN','EH':'CN','KNDI':'CN',
  'ZLAB':'CN','ZTO':'CN','BEKE':'CN','TUYA':'CN','GDS':'CN','HCM':'CN','JOYY':'CN',
  'NIU':'CN','QFIN':'CN','TCOM':'CN','WB':'CN','XIN':'CN','XYF':'CN','CREG':'CN',
  'CETX':'CN','CHEK':'CN','FAMI':'CN','FENG':'CN','GLBR':'CN','SDH':'CN','DQ':'CN',
  'NWTN':'CN','TC':'CN','TIRX':'CN','WIMI':'CN','YQ':'CN','ZW':'CN','LIZI':'CN',
  'MEGL':'CN','MGRX':'CN','TANH':'CN','AIH':'CN','ATIF':'CN','CMCM':'CN','GHG':'CN',
  'GSUN':'CN','JFIN':'CN','NCTY':'CN','DDL':'CN','OPRT':'CN','BZ':'CN','LXEH':'CN',
  'DOYU':'CN','SOL':'CN','EZGO':'CN','TWND':'CN','SY':'CN','ZJYL':'CN','LOBO':'CN',
  // Additional Chinese microcaps (commonly seen in small-cap pump alerts)
  'AEHL':'CN','DXF':'CN','BIMI':'CN','BTOG':'CN','CAAS':'CN','CBAT':'CN','CCM':'CN',
  'CETY':'CN','CJET':'CN','CLEU':'CN','CLPS':'CN','CNET':'CN','CNEY':'CN','DDC':'CN',
  'DOGZ':'CN','GLG':'CN','GMM':'CN','GSMG':'CN','HKD':'CN','HUDI':'CN','IH':'CN',
  'JFU':'CN','JG':'CN','JZ':'CN','KXIN':'CN','LICN':'CN','MGIH':'CN','MHUA':'CN',
  'NAAS':'CN','NIPG':'CN','NVFY':'CN','SXTC':'CN','TIAN':'CN','YGMZ':'CN','YOOV':'CN',
  'AIFU':'CN','XHG':'CN','MFI':'CN','UTSI':'CN','HOLO':'CN','EPOW':'CN','ICCT':'CN',
  'YIBO':'CN','SISI':'CN','TROO':'CN','QYOU':'CN','WETG':'CN','SUGP':'CN','QUCY':'CN',
  'BRTX':'CN','TPST':'CN','MTC':'CN','SNAL':'CN','TGL':'CN','GFAI':'CN','BNRG':'CN',
  // Hong Kong
  'PNGAY':'HK','LFC':'HK','CHL':'HK',
  // Israel
  'NRSN':'IL','TEVA':'IL','CHKP':'IL','NICE':'IL','MNDY':'IL','WIX':'IL','SOLY':'IL',
  'CYBR':'IL','RDWR':'IL','TARO':'IL','TOMI':'IL','GRWG':'IL','ELBT':'IL','PLTK':'IL',
  'CMCT':'IL','MTNB':'IL','NVMI':'IL','SLDB':'IL','GLBE':'IL','BVS':'IL','MNTS':'IL',
  'GLMD':'IL','ENLV':'IL','ALTI':'IL','BTBT':'IL','SVRA':'IL','GILT':'IL','ALLT':'IL',
  'AUDC':'IL','ZIM':'IL','ICCM':'IL','OPRX':'IL','ORMP':'IL','UAVS':'IL','PRPL':'IL',
  // United Kingdom
  'ARM':'GB','BP':'GB','HSBC':'GB','SHEL':'GB','UL':'GB','AZN':'GB','GSK':'GB',
  'RIO':'GB','BCS':'GB','LYG':'GB','VOD':'GB',
  // Canada
  'SHOP':'CA','BNS':'CA','TD':'CA','BMO':'CA','CM':'CA','RY':'CA','ENB':'CA',
  'TRP':'CA','CNQ':'CA','CVE':'CA','SU':'CA','ABX':'CA','AEM':'CA','CNI':'CA',
  'WCN':'CA','MFC':'CA','GIB':'CA','OTEX':'CA','BCE':'CA','TRI':'CA',
  // Singapore
  'SE':'SG','GRAB':'SG','ATAT':'SG','GHG':'SG',
  // Brazil
  'VALE':'BR','ITUB':'BR','PBR':'BR','ABEV':'BR','BBD':'BR','GGB':'BR','ERJ':'BR',
  'NU':'BR','XP':'BR','PAGS':'BR','STNE':'BR',
  // India
  'INFY':'IN','WIT':'IN','HDB':'IN','IBN':'IN','SIFY':'IN','RDY':'IN','TTM':'IN',
  // Japan
  'TM':'JP','HMC':'JP','SONY':'JP','MUFG':'JP','MFG':'JP','NMR':'JP','NTT':'JP',
  // Korea
  'KB':'KR','SHG':'KR','KEP':'KR','LPL':'KR',
  // Taiwan
  'TSM':'TW','UMC':'TW','ASX':'TW',
  // Ireland
  'RYAAY':'IE','GMAB':'IE','SHPG':'IE','PRGO':'IE','SMMT':'IE',
  // Netherlands
  'ASML':'NL','NXPI':'NL','ING':'NL','PHG':'NL','RDS':'NL',
  // Germany
  'SAP':'DE','PSO':'DE','BAYRY':'DE','SIEGY':'DE',
  // France
  'TTE':'FR','SNY':'FR','LVMUY':'FR','IPHA':'FR',
  // Switzerland
  'NVS':'CH','ROG':'CH','UBS':'CH','NESN':'CH','ABBN':'CH',
  // Sweden
  'ERIC':'SE','SPOT':'SE','VOLV':'SE',
  // Australia
  'BHP':'AU','RIO':'AU','TLS':'AU',
  // Mexico
  'AMX':'MX','FMX':'MX','KOF':'MX',
  // Argentina
  'YPF':'AR','GGAL':'AR','PAM':'AR','TEO':'AR',
};

// Returns a country flag emoji for every ticker, no exceptions.
// Order of authority (highest → lowest):
//   1. FOREIGN_TICKER_OVERRIDES — hand-curated ADRs/foreign listings
//   2. Polygon ticker-details auto-detection (address.country / phone_number)
//   3. Polygon locale (broad fallback: us = 🇺🇸)
//   4. Default 🇺🇸 — safe fallback so the alert format never breaks
function flag(ticker){
  if(!ticker) return '🇺🇸';
  // 1) Manual override map — highest confidence, hand-curated for ADRs
  const ov = FOREIGN_TICKER_OVERRIDES[ticker];
  if(ov) return countryFlag(ov);
  // 2) Auto-detected from Polygon ticker details (address.country / phone)
  const c = countryMap.get(ticker);
  if(c) return countryFlag(c);
  // 3) Default — never return empty, every alert gets a flag
  return '🇺🇸';
}
function isBadTicker(t) {
  if(!t||t.length<2)return true;
  if(t.includes('.'))return true;
  if(/^[A-Z]{5}$/.test(t)&&/[FQEX]$/.test(t))return true;
  if(/WS?$/.test(t)&&t.length>=5)return true;
  if(/^[A-Z]{4,5}R$/.test(t))return true;
  if(/^[A-Z]{4,5}U$/.test(t))return true;
  return false;
}

// ─── HTTP / API ───────────────────────────────────────────────────────────────
function rawGet(url,hdrs={}) {
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'AziziBot/1.0',...hdrs}},res=>{
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d));
    });
    req.on('error',reject);
    req.setTimeout(8000,()=>{req.destroy();reject(new Error('timeout'));});
  });
}
async function jsonGet(url){try{return JSON.parse(await rawGet(url));}catch(e){return null;}}
function polyGet(path){
  const sep=path.includes('?')?'&':'?';
  return jsonGet(`https://api.polygon.io${path}${sep}apiKey=${POLY_KEY}`);
}

async function postToWebhook(url,payload){
  return new Promise(resolve=>{
    const body=JSON.stringify(payload);
    const u=new URL(url);
    const req=https.request({
      hostname:u.hostname,path:u.pathname+u.search,method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
    },res=>{
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        if(res.statusCode!==204&&res.statusCode!==200)
          console.error(`[Webhook] HTTP ${res.statusCode}: ${d.slice(0,200)}`);
        resolve(res.statusCode);
      });
    });
    req.on('error',e=>{console.error('[Webhook] error:',e.message);resolve(0);});
    req.setTimeout(5000,()=>{req.destroy();resolve(0);});
    req.write(body); req.end();
  });
}
async function post(payload){
  payload.username='AziziBot';
  await postToWebhook(MAIN_CHAT_WH,payload);
}
// Halt + resume alerts broadcast to every webhook in HALT_ALERT_WHS in
// parallel. If the list is empty, alerts are suppressed (logged only).
async function postHalt(payload){
  if(!HALT_ALERT_WHS.length){
    console.log('[Halt] suppressed (no webhooks configured)');
    return;
  }
  payload.username='AziziBot';
  await Promise.all(HALT_ALERT_WHS.map(wh => postToWebhook(wh, payload)));
}
function discordRest(method,path,body=null){
  return new Promise((resolve,reject)=>{
    const data=body?JSON.stringify(body):null;
    const req=https.request({
      hostname:'discord.com',path:`/api/v10${path}`,method,
      headers:{'Authorization':`Bot ${DISCORD_TOKEN}`,'Content-Type':'application/json',...(data?{'Content-Length':Buffer.byteLength(data)}:{})}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){resolve({});}});});
    req.on('error',reject);
    if(data) req.write(data);
    req.end();
  });
}

// ─── ETF list ─────────────────────────────────────────────────────────────────
const ETF_FALLBACK=new Set(['SPY','QQQ','IWM','DIA','GLD','SLV','TLT','HYG','VXX','UVXY',
  'SQQQ','TQQQ','SPXU','SPXL','SOXL','SOXS','TECL','TECS','LABD','LABU','NUGT','DUST',
  'FAS','FAZ','TNA','TZA','UPRO','SDOW','UDOW','GUSH','DRIP','ERX','ERY','BOIL','KOLD',
  'ARKK','ARKG','ARKW','ARKF','GDX','GDXJ','XLF','XLE','XLK','XLV','XLI','XLP','XLU',
  'VTI','VOO','IVV','IJR','IJH']);
let etfSet=new Set(ETF_FALLBACK), lastEtfRefresh=0;
async function refreshEtfList(){
  if(Date.now()-lastEtfRefresh<6*60*60*1000) return;
  try{
    let path='/v3/reference/tickers?type=ETF&market=stocks&active=true&limit=1000';
    const s=new Set(ETF_FALLBACK); let pages=0;
    while(path&&pages<5){
      const r=await polyGet(path); if(!r||!r.results) break;
      r.results.forEach(t=>s.add(t.ticker));
      path=r.next_url?r.next_url.replace('https://api.polygon.io',''):null; pages++;
    }
    if(s.size>100){etfSet=s;lastEtfRefresh=Date.now();console.log(`[ETF] ${s.size} tickers`);}
  }catch(e){console.error('[ETF] refresh failed:',e.message);}
}
function isEtf(t){return etfSet.has(t);}

// ─── Reg SHO threshold list ───────────────────────────────────────────────────
// Daily threshold security lists from NASDAQ and NYSE (combined). Updated by
// the exchanges after the close each settlement day. We walk back up to 5 days
// per source to find the most recent available file (handles weekends, holidays,
// and late publication). Both files use the same pipe-delimited format:
//   Symbol|Security Name|Market Category|Reg SHO Threshold Flag|Filler|Filler
// The trailing line is a YYYYMMDDHHMMSS timestamp.
const regSHOSet = new Set();
let lastRegSHORefresh = 0;
const REG_SHO_REFRESH_MS = 23*60*60*1000;

function _ymd(d){ return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
function _ddMmmYyyy(d){
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(d.getDate()).padStart(2,'0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
}
function _parseRegSHOText(text){
  const out = [];
  if(!text||!text.includes('|')) return out;
  for(const raw of text.split(/\r?\n/)){
    const line = raw.trim();
    if(!line) continue;
    if(/^\d{14}$/.test(line)) continue; // timestamp footer
    if(line.startsWith('Symbol|')) continue; // header
    const parts = line.split('|');
    if(parts.length < 4) continue;
    const sym = (parts[0]||'').trim().toUpperCase();
    const flag = (parts[3]||'').trim().toUpperCase();
    if(sym && flag === 'Y') out.push(sym);
  }
  return out;
}

async function refreshRegSHO(){
  if(Date.now() - lastRegSHORefresh < REG_SHO_REFRESH_MS) return;
  const found = new Set();
  const browserUA = {'User-Agent':'Mozilla/5.0 (Linux; Railway) AziziBot/1.0','Accept':'text/plain,application/octet-stream,*/*'};

  // NASDAQ — walk back up to 5 days
  for(let i=0; i<5; i++){
    const d = new Date(Date.now() - i*86400000);
    try {
      const txt = await rawGet(`https://www.nasdaqtrader.com/dynamic/SymDir/regsho/nasdaqth${_ymd(d)}.txt`, browserUA);
      const tickers = _parseRegSHOText(txt);
      if(tickers.length > 0){
        tickers.forEach(t => found.add(t));
        console.log(`[RegSHO] NASDAQ ${_ymd(d)}: ${tickers.length} tickers`);
        break;
      }
    } catch(e){}
  }

  // NYSE — walk back up to 5 days
  for(let i=0; i<5; i++){
    const d = new Date(Date.now() - i*86400000);
    try {
      const txt = await rawGet(`https://www.nyse.com/api/regulatory/threshold-securities/download?selectedDate=${_ddMmmYyyy(d)}`, browserUA);
      const tickers = _parseRegSHOText(txt);
      if(tickers.length > 0){
        tickers.forEach(t => found.add(t));
        console.log(`[RegSHO] NYSE ${_ddMmmYyyy(d)}: ${tickers.length} tickers`);
        break;
      }
    } catch(e){}
  }

  if(found.size > 0){
    regSHOSet.clear();
    found.forEach(t => regSHOSet.add(t));
    lastRegSHORefresh = Date.now();
    console.log(`[RegSHO] Combined: ${regSHOSet.size} unique threshold tickers`);
  } else {
    console.error('[RegSHO] Both sources returned nothing — keeping previous list');
  }
}

function isRegSHO(ticker){ return regSHOSet.has((ticker||'').toUpperCase()); }


// ─── Caches ───────────────────────────────────────────────────────────────────
const countryMap=new Map(), tickerCache=new Map(), newsCache=new Map(), ctbCache=new Map();

async function getTickerDetails(ticker){
  const c=tickerCache.get(ticker);
  if(c&&Date.now()-c.ts<4*60*60*1000) return c.data;
  try{
    const r=await polyGet(`/v3/reference/tickers/${ticker}`);
    const data=(r&&r.results)||{};
    tickerCache.set(ticker,{data,ts:Date.now()});
    // Extract HQ country from multiple Polygon fields. address.country is the
    // strongest signal — explicitly populated for ADRs of foreign companies
    // (GLMD → "Israel", BABA → "China"). Falls back to phone country code
    // prefix (+972 = IL, +86 = CN, +33 = FR, etc) when address is sparse.
    // Last resort: locale (only knows us/global, but better than nothing).
    const cc = resolveCountry(data);
    if(cc) countryMap.set(ticker, cc);
    return data;
  }catch(e){return {};}
}

// Convert raw Polygon ticker-details fields into a 2-letter ISO country code.
// Returns '' if no signal — caller falls through to FOREIGN_TICKER_OVERRIDES /
// 🇺🇸 default. Country names mapped to ISO codes for the markets that
// commonly produce ADRs on US exchanges.
// Auto-detect a ticker's home country from Polygon's ticker-details payload.
// Priority order (highest → lowest confidence):
//   1. address.city matches a known foreign metro (Polygon often gets city
//      right even when address.country wrongly says "United States" for ADRs)
//   2. description contains "X-based" / "headquartered in X" / "based in X"
//   3. description contains the country name with strong context (provinces, "PRC")
//   4. address.country structured field (current logic)
//   5. phone_number country code prefix
//   6. locale fallback
//
// Each country is defined once below with all its signals so adding a new
// country is a one-line config change, not a code change.
const COUNTRY_RULES = [
  {iso:'CN',
   names:['china','chinese','people\'s republic of china','prc','mainland china'],
   cities:['beijing','shanghai','shenzhen','guangzhou','hangzhou','chengdu','wuhan','nanjing','tianjin','xiamen','qingdao','dalian','fuzhou','jinan','hefei','kunming','changsha','wuxi','ningbo','suzhou','zhengzhou','chongqing','harbin','shenyang','xian',"xi'an",'foshan','dongguan','urumqi','taiyuan','lanzhou','nanchang','nanning','jinjiang','quanzhou','zibo','linyi','weifang','tangshan','baoding'],
   addr:['china','cn','people\'s republic of china','prc'],
   phone:'+86'},
  {iso:'HK',
   names:['hong kong','hongkong'],
   cities:['hong kong','hongkong','kowloon','central','wan chai'],
   addr:['hong kong','hk'], phone:'+852'},
  {iso:'TW',
   names:['taiwan','taiwanese','republic of china'],
   cities:['taipei','kaohsiung','taichung','taoyuan','tainan','hsinchu'],
   addr:['taiwan','tw'], phone:'+886'},
  {iso:'IL',
   names:['israel','israeli'],
   cities:['tel aviv','jerusalem','herzliya','haifa','netanya','ramat gan','rehovot','petah tikva','bnei brak','ashdod','yokneam'],
   addr:['israel','il'], phone:'+972'},
  {iso:'GB',
   names:['united kingdom','great britain','british','english','scotland','scottish','wales','welsh'],
   cities:['london','manchester','edinburgh','glasgow','birmingham','cambridge','oxford','liverpool','leeds','bristol','sheffield','newcastle','cardiff','belfast'],
   addr:['united kingdom','uk','great britain','gb','england','scotland'], phone:'+44'},
  {iso:'CA',
   names:['canada','canadian'],
   cities:['toronto','vancouver','montreal','calgary','ottawa','edmonton','winnipeg','quebec','halifax','victoria','mississauga','burnaby','markham','oakville'],
   addr:['canada','ca'], phone:null}, // +1 ambiguous with US
  {iso:'FR',
   names:['france','french'],
   cities:['paris','lyon','marseille','nice','toulouse','nantes','bordeaux','strasbourg'],
   addr:['france','fr'], phone:'+33'},
  {iso:'DE',
   names:['germany','german','deutschland'],
   cities:['berlin','munich','frankfurt','hamburg','cologne','stuttgart','düsseldorf','dusseldorf','leipzig'],
   addr:['germany','de'], phone:'+49'},
  {iso:'NL',
   names:['netherlands','dutch','holland'],
   cities:['amsterdam','rotterdam','the hague','utrecht','eindhoven'],
   addr:['netherlands','nl'], phone:'+31'},
  {iso:'CH',
   names:['switzerland','swiss'],
   cities:['zurich','geneva','basel','bern','lausanne','lugano','zug'],
   addr:['switzerland','ch'], phone:'+41'},
  {iso:'IE',
   names:['ireland','irish'],
   cities:['dublin','cork','limerick','galway'],
   addr:['ireland','ie'], phone:'+353'},
  {iso:'JP',
   names:['japan','japanese'],
   cities:['tokyo','osaka','kyoto','yokohama','nagoya','sapporo','kobe','fukuoka'],
   addr:['japan','jp'], phone:'+81'},
  {iso:'KR',
   names:['south korea','korean','republic of korea'],
   cities:['seoul','busan','incheon','daegu','daejeon','gwangju'],
   addr:['south korea','korea','kr'], phone:'+82'},
  {iso:'SG',
   names:['singapore','singaporean'],
   cities:['singapore'],
   addr:['singapore','sg'], phone:'+65'},
  {iso:'AU',
   names:['australia','australian'],
   cities:['sydney','melbourne','brisbane','perth','adelaide','canberra','gold coast'],
   addr:['australia','au'], phone:'+61'},
  {iso:'BR',
   names:['brazil','brazilian'],
   cities:['são paulo','sao paulo','rio de janeiro','brasília','brasilia','salvador','fortaleza'],
   addr:['brazil','br'], phone:'+55'},
  {iso:'IN',
   names:['india','indian'],
   cities:['mumbai','delhi','bangalore','bengaluru','chennai','kolkata','hyderabad','pune','ahmedabad','gurgaon','noida'],
   addr:['india','in'], phone:'+91'},
  {iso:'MX',
   names:['mexico','mexican'],
   cities:['mexico city','guadalajara','monterrey'],
   addr:['mexico','mx'], phone:'+52'},
  {iso:'SE',
   names:['sweden','swedish'],
   cities:['stockholm','gothenburg','malmö','malmo','uppsala'],
   addr:['sweden','se'], phone:'+46'},
  {iso:'ES',
   names:['spain','spanish'],
   cities:['madrid','barcelona','valencia','seville','sevilla'],
   addr:['spain','es'], phone:'+34'},
  {iso:'IT',
   names:['italy','italian'],
   cities:['rome','milan','milano','naples','turin','torino','florence','firenze'],
   addr:['italy','it'], phone:'+39'},
  {iso:'NO',
   names:['norway','norwegian'],
   cities:['oslo','bergen','trondheim','stavanger'],
   addr:['norway','no'], phone:'+47'},
  {iso:'DK',
   names:['denmark','danish'],
   cities:['copenhagen','aarhus','odense'],
   addr:['denmark','dk'], phone:'+45'},
  {iso:'FI',
   names:['finland','finnish'],
   cities:['helsinki','espoo','tampere','vantaa'],
   addr:['finland','fi'], phone:'+358'},
  {iso:'BE',
   names:['belgium','belgian'],
   cities:['brussels','antwerp','ghent','bruges'],
   addr:['belgium','be'], phone:'+32'},
  {iso:'AT',
   names:['austria','austrian'],
   cities:['vienna','salzburg','graz','innsbruck'],
   addr:['austria','at'], phone:'+43'},
  {iso:'LU',
   names:['luxembourg'],
   cities:['luxembourg'],
   addr:['luxembourg','lu'], phone:'+352'},
  {iso:'GR',
   names:['greece','greek'],
   cities:['athens','thessaloniki'],
   addr:['greece','gr'], phone:'+30'},
  {iso:'TR',
   names:['turkey','turkish'],
   cities:['istanbul','ankara','izmir'],
   addr:['turkey','tr'], phone:'+90'},
  {iso:'ZA',
   names:['south africa','south african'],
   cities:['johannesburg','cape town','durban','pretoria'],
   addr:['south africa','za'], phone:'+27'},
  {iso:'AR',
   names:['argentina','argentine','argentinian'],
   cities:['buenos aires','córdoba','cordoba','rosario'],
   addr:['argentina','ar'], phone:'+54'},
  {iso:'CL',
   names:['chile','chilean'],
   cities:['santiago','valparaíso','valparaiso','concepción','concepcion'],
   addr:['chile','cl'], phone:'+56'},
  {iso:'BM', names:['bermuda'], cities:['hamilton'], addr:['bermuda','bm'], phone:'+1441'},
  {iso:'KY', names:['cayman islands'], cities:['george town'], addr:['cayman islands','ky'], phone:'+1345'},
];

function resolveCountry(data){
  if(!data) return '';
  const desc = (data.description || '').toLowerCase();
  const name = (data.name || '').toLowerCase();
  const addr = data.address || {};
  const city = (addr.city || '').toLowerCase().trim();
  const addrCountry = (addr.country || '').toLowerCase().trim();
  const phone = (data.phone_number || '').replace(/\s|-/g,'');

  // 1. address.city match — strongest signal. Polygon often has the correct
  //    city even when address.country wrongly says United States for ADRs.
  if(city){
    for(const r of COUNTRY_RULES){
      if(r.cities.includes(city)) return r.iso;
    }
  }

  // 2. Description has strong HQ phrase: "X-based", "headquartered in X",
  //    "based in X", "principal offices in X". These are specific enough to
  //    avoid false positives like "we ship to China."
  for(const r of COUNTRY_RULES){
    for(const n of r.names){
      const nEsc = n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const hqRe = new RegExp(
        `\\b(?:headquartered|based|located|incorporated|registered|operates|operating|domiciled)\\s+(?:in|across|throughout|within|out\\s+of)\\s+(?:the\\s+)?${nEsc}\\b|\\b${nEsc}-based\\b|\\bis\\s+a\\s+(?:leading\\s+)?${nEsc}\\b`,
        'i'
      );
      if(hqRe.test(desc) || hqRe.test(name)) return r.iso;
    }
  }

  // 3. Description contains country name with strong context — last bullet
  //    of description for most foreign ADRs reads "... in the People's
  //    Republic of China." Pattern: country name followed by sentence end.
  for(const r of COUNTRY_RULES){
    for(const n of r.names){
      const nEsc = n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const ctxRe = new RegExp(`\\b(?:in|across|of|to)\\s+(?:the\\s+)?${nEsc}\\b[.,;]`, 'i');
      if(ctxRe.test(desc)) return r.iso;
    }
  }

  // 4. address.country structured field
  if(addrCountry){
    for(const r of COUNTRY_RULES){
      if(r.addr.includes(addrCountry)) return r.iso;
    }
    if(['united states','usa','us'].includes(addrCountry)) return 'US';
  }

  // 5. Phone country-code prefix
  if(phone.startsWith('+')){
    for(const r of COUNTRY_RULES){
      if(r.phone && phone.startsWith(r.phone)) return r.iso;
    }
  }

  // 6. Polygon locale fallback (only knows broad us/global distinction)
  if(data.locale){
    const loc = data.locale.toUpperCase();
    if(loc !== 'US' && loc !== 'GLOBAL') return loc;
  }
  return '';
}

async function getNewsUrl(ticker){
  const c=newsCache.get(ticker);
  if(c&&Date.now()-c.ts<15*60*1000) return c.url;
  try{
    const r=await polyGet(`/v2/reference/news?ticker=${ticker}&limit=1&order=desc&sort=published_utc`);
    const item=r&&r.results&&r.results[0]; if(!item) return null;
    if(new Date(item.published_utc||0).getTime()<new Date().setHours(0,0,0,0)) return null;
    const url=item.article_url||null;
    if(url) newsCache.set(ticker,{url,ts:Date.now()});
    return url;
  }catch(e){return null;}
}
async function getRecentSplit(ticker){
  try{
    const r=await polyGet(`/v3/reference/splits?ticker=${ticker}&limit=5&order=desc`);
    const s=(r&&r.results||[]).find(s=>{
      const d=(Date.now()-new Date(s.execution_date).getTime())/86400000;
      return d<=90&&s.split_from>s.split_to;
    });
    if(s){const d=new Date(s.execution_date);return`${s.split_to} for ${s.split_from} R/S ${d.toLocaleString('en-US',{month:'short'})}. ${d.getDate()}`;}
  }catch(e){}
  return null;
}
// FMP shares-float endpoint (Ultimate plan) — reliable structured data,
// replaces fragile Finviz HTML scraping for float. Cached 12h.
// ─── Polygon Short Interest ──────────────────────────────────────────────────
// Replaces fragile Finviz HTML scrape with Polygon's official endpoint.
// FINRA cadence: settlement data refreshed every 2 weeks. Cache 24h.
// Returns SI% computed as short_interest / shares_outstanding * 100.
const polySICache = new Map();
async function getPolySI(ticker){
  const c = polySICache.get(ticker);
  if(c && Date.now()-c.ts < 24*60*60*1000) return c.data;
  try {
    // Latest record for this ticker. Polygon returns highest settlement_date first
    // when sorted desc; defaulting to limit=1 keeps the response tiny.
    const r = await polyGet(`/stocks/v1/short-interest?ticker=${ticker}&limit=1&sort=settlement_date.desc`);
    if(!r || !Array.isArray(r.results) || r.results.length === 0){
      polySICache.set(ticker,{data:null,ts:Date.now()-23*60*60*1000}); // short-cache empty
      return null;
    }
    const row = r.results[0];
    const shortShares = +row.short_interest || 0;
    const adv = +row.avg_daily_volume || 0;
    const dtc = +row.days_to_cover || 0;
    // Get share count for SI% calc — share_class_shares_outstanding from ticker details
    const det = await getTickerDetails(ticker);
    const sharesOut = +det.share_class_shares_outstanding || +det.weighted_shares_outstanding || 0;
    const siPct = (shortShares > 0 && sharesOut > 0) ? (shortShares / sharesOut) * 100 : 0;
    const data = {
      shortShares,
      adv,
      dtc,
      sharesOut,
      siPct,                                       // e.g. 18.7
      siStr: siPct > 0 ? siPct.toFixed(1) + '%' : '--',
      settlementDate: row.settlement_date || '',
    };
    polySICache.set(ticker,{data,ts:Date.now()});
    return data;
  } catch(e) {
    console.error(`[Poly SI] ${ticker} error:`, e.message);
    return null;
  }
}

// Stats for alerts: SI from Polygon, Float from Polygon shares-outstanding,
// IO still from Finviz (no clean replacement — 13F aggregation is heavy).
async function getFinvizStats(ticker){
  const r = {si:'--', float:'--', io:'--'};
  // Polygon SI (official FINRA data)
  const psi = await getPolySI(ticker);
  if(psi){
    if(psi.siStr !== '--') r.si = psi.siStr;
    if(psi.sharesOut > 0) r.float = fmtNS(psi.sharesOut).trim();
  }
  // Finviz fallback for IO (and a SI/float backup if Polygon is empty)
  if(r.io === '--' || r.si === '--' || r.float === '--'){
    try {
      const html = await rawGet(`https://finviz.com/quote.ashx?t=${ticker}`, {
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':'text/html','Accept-Language':'en-US,en;q=0.5'
      });
      if(html.length > 1000){
        if(r.float === '--'){
          const fm = html.match(/Shs Float<\/b><\/td>\s*<td[^>]*>([^<]+)<\/td>/i) || html.match(/Shs Float[^<]*<\/td>[^<]*<td[^>]*>([^<]+)<\/td>/i);
          if(fm && fm[1] && fm[1] !== '-') r.float = fm[1].trim();
        }
        if(r.si === '--'){
          const sm = html.match(/Short Float[^<]*<\/b><\/td>\s*<td[^>]*>([\d.]+%?)<\/td>/i) || html.match(/Short Float[^<]*<\/td>[^<]*<td[^>]*>([\d.]+%?)<\/td>/i);
          if(sm && sm[1] && sm[1] !== '-') r.si = sm[1].includes('%') ? sm[1].trim() : sm[1].trim() + '%';
        }
        const im = html.match(/Inst Own[^<]*<\/b><\/td>\s*<td[^>]*>([\d.]+%?)<\/td>/i) || html.match(/Inst Own[^<]*<\/td>[^<]*<td[^>]*>([\d.]+%?)<\/td>/i);
        if(im && im[1] && im[1] !== '-') r.io = im[1].includes('%') ? im[1].trim() : im[1].trim() + '%';
      }
    } catch(e){}
  }
  return r;
}

async function getGreenBars(ticker){
  // NuntioBot checks multiple bar timeframes and shows whichever has the most
  // consecutive green closes. We check 1m and 3m and pick the higher count.
  const today=new Date().toISOString().slice(0,10);
  async function checkTf(tf){
    try{
      const r=await polyGet(`/v2/aggs/ticker/${ticker}/range/${tf}/minute/${today}/${today}?adjusted=true&sort=desc&limit=10`);
      const bars=(r&&r.results)||[]; let count=0;
      for(const bar of bars){if(bar.c>bar.o)count++;else break;}
      return count;
    }catch(e){return 0;}
  }
  const [c1,c3]=await Promise.all([checkTf(1),checkTf(3)]);
  // Tie-break to 1m — more responsive signal when both show same count.
  return c3>c1 ? {count:c3,timeframe:'3m'} : {count:c1,timeframe:'1m'};
}

// ─── Cost-to-borrow (CTB) ─────────────────────────────────────────────────────
// Free unofficial API scraping IBKR's stock loan data. Cached 1h.
// Fee is in % per annum. >20% = High CTB (rough industry threshold).
async function getCTB(ticker){
  const c=ctbCache.get(ticker);
  if(c&&Date.now()-c.ts<60*60*1000) return c.data;
  const empty={fee:0,available:0,date:''};
  try{
    const raw=await rawGet(`https://iborrowdesk.com/api/ticker/${ticker}`,{
      'User-Agent':'Mozilla/5.0 (Linux; Railway) AziziBot/1.0',
      'Accept':'application/json',
    });
    // iborrowdesk.com sometimes returns an HTML error page (rate limit, downtime,
    // CloudFlare challenge). Detect this BEFORE JSON.parse so we don't spam logs.
    if(!raw || raw.trimStart().startsWith('<') || raw.length < 20){
      ctbCache.set(ticker,{data:empty,ts:Date.now()-50*60*1000});
      return empty;
    }
    const j=JSON.parse(raw);
    const daily=(j&&j.daily)||[];
    if(daily.length===0){
      ctbCache.set(ticker,{data:empty,ts:Date.now()-50*60*1000}); // short-cache empty result, retry in 10min
      return empty;
    }
    const latest=daily[daily.length-1];
    const data={fee:+latest.fee||0, available:+latest.available||0, date:latest.date||''};
    ctbCache.set(ticker,{data,ts:Date.now()});
    if(data.fee>=10) console.log(`[CTB] ${ticker} fee:${data.fee.toFixed(2)}% avail:${data.available}`);
    return data;
  }catch(e){
    // Suppress JSON parse spam — log only true network/timeout errors
    if(!String(e.message).includes('JSON')){
      console.error(`[CTB] ${ticker} error:`,e.message);
    }
    ctbCache.set(ticker,{data:empty,ts:Date.now()-50*60*1000});
    return empty;
  }
}

// ─── State ────────────────────────────────────────────────────────────────────
let topGappers=[];
const dayWatchlist=new Map();
const state={tickers:new Map(),dailyCounts:new Map(),sentNews:new Set(),sentFilings:new Set(),sentPR:new Set(),morningPosted:new Set()};
const wsDebounce=new Map();
const closePrice=new Map(); // ticker → price at 4PM close
// recentRunners: tickers that qualified as gappers in the last 5 days
// Used to expand news coverage beyond just today's movers
const recentRunners=new Map(); // ticker → timestamp when last seen as gapper

// permanentWatch: loaded from watchlist.txt — monitored forever, no gates
const permanentWatch=new Set();
let lastWatchlistRead=0;

// ─── Instant event alert ─────────────────────────────────────────────────────
// Posts a single header+bullet message immediately. No buffering, no aggregation.
// All event types (PR, SEC, INSIDER, GRADE) share this format and gate set.
async function postEventAlert(ticker, event) {
  // Fresh snapshot for header
  const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
  const td = snap && snap.ticker;
  const price = (td && td.lastTrade && td.lastTrade.p) || (td && td.day && td.day.c) || 0;
  if (price < 0.10) { console.log(`[Alert] ${ticker} skip: price ${price}`); return; }

  const [det, fv] = await Promise.all([
    getTickerDetails(ticker), getFinvizStats(ticker),
  ]);
  const mc = det.market_cap || 0;
  const { timeStr } = getET();
  const timeShort = timeStr.slice(0, 5);

  const ioStr = fv.io !== '--' ? ` | **IO:** ${fv.io}` : '';
  const mcStr = mc > 0 ? ` | **MC:** ${fmtNS(mc)}` : '';
  const siStr = fv.si !== '--' ? ` | **SI:** ${fv.si}` : '';
  const header = `\`${timeShort}\` ↗ **${ticker}** ${priceFlag(price)} ~ ${flag(ticker)}${ioStr}${mcStr}${siStr}`;

  const ageMs = Date.now() - new Date(event.publishedTime || Date.now()).getTime();
  const ageStr = fmtAge(Math.max(ageMs, 0));
  const typePill = `\`${event.type}\``; // `PR` or `SEC`
  const titlePart = event.title || '';
  const linkPart = event.url ? ` - [Link](<${event.url}>)` : '';
  const bullet = `> • \`${ageStr}\` ${typePill} ${titlePart}${linkPart}`;

  await post({ content: `${header}\n${bullet}` });
  console.log(`[Alert] ${ticker} ${event.type} posted instantly`);
}

function loadPermanentWatchlist(){
  try{
    const path='/app/watchlist.txt';
    if(!fs.existsSync(path)){console.log('[Watch] watchlist.txt not found — skipping');return;}
    const lines=fs.readFileSync(path,'utf8').split('\n');
    const prev=permanentWatch.size;
    permanentWatch.clear();
    for(const line of lines){
      const t=line.trim().toUpperCase().replace(/[^A-Z]/g,'');
      if(t&&t.length>=1&&t.length<=5) permanentWatch.add(t);
    }
    if(permanentWatch.size!==prev)
      console.log(`[Watch] Permanent watchlist: ${permanentWatch.size} tickers loaded`);
  }catch(e){console.error('[Watch] Failed to load watchlist.txt:',e.message);}
}

// ─── Gapper refresh ───────────────────────────────────────────────────────────
async function refreshGappers(){
  try{
    if(!isMarketDay()) return;
    const {etMin,timeStr}=getET();
    const tier=getTier(etMin);
    if(!tier) return;

    const [g1,g2,g3]=await Promise.all([
      polyGet('/v2/snapshot/locale/us/markets/stocks/gainers'),
      polyGet('/v2/snapshot/locale/us/markets/stocks/tickers?sort=changePercent&direction=desc&limit=250'),
      polyGet('/v2/snapshot/locale/us/markets/stocks/tickers?sort=volume&direction=desc&limit=250'),
    ]);
    const c1=g1?.tickers?.length||0,c2=g2?.tickers?.length||0,c3=g3?.tickers?.length||0;
    console.log(`[Poly] gainers:${c1} pct:${c2} vol:${c3}`);
    if(c1===0&&c2===0&&c3===0){console.error('[Poly] ALL EMPTY — check POLY_KEY');return;}

    const build=t=>{
      // Use lastTrade.p (real-time last trade, includes pre-market) for price.
      // Fall back to day.c only if lastTrade is missing.
      const lastP  = (t.lastTrade&&t.lastTrade.p)||0;
      const dayC   = (t.day&&t.day.c)||0;
      const price  = lastP||dayC||0;
      const prev   = (t.prevDay&&t.prevDay.c)||0;
      // Calculate % change from prev close. Fall back to Polygon's own field.
      const chgPct = (price>0&&prev>0) ? ((price-prev)/prev)*100 : (t.todaysChangePerc||0);
      const vol    = (t.day&&t.day.v)||0;
      const pv2    = (t.prevDay&&t.prevDay.v)||0;
      const mins   = Math.max(etMin-240,1);
      const rvol   = pv2>0?(vol*390)/(mins*pv2):0;
      const isOTC  = /OTC|GREY|PINK|EXPERT/i.test(t.primaryExchange||'');
      return {ticker:t.ticker,price,prev,chgPct,volume:vol,prevVol:pv2,rvol,
              high:price, dayHigh:(t.day&&t.day.h)||price, isOTC,
              _lastP:lastP,_dayC:dayC}; // keep raw fields for debug
    };

    const merge=new Map();
    for(const src of [g1,g2,g3])
      for(const t of ((src&&src.tickers)||[]))
        if(t.ticker&&!merge.has(t.ticker)) merge.set(t.ticker,build(t));

    // ── Debug: log top 10 by chgPct from raw merge (before any filter) ────
    const top10=[...merge.values()]
      .filter(t=>t.chgPct>0)
      .sort((a,b)=>b.chgPct-a.chgPct)
      .slice(0,10);
    if(top10.length>0)
      console.log(`[RAW-TOP10] ${top10.map(t=>`${t.ticker}:${t.chgPct.toFixed(0)}%,lastP:${t._lastP},dayC:${t._dayC},prev:${t.prev},vol:${fmtN(t.volume)},otc:${t.isOTC}`).join(' | ')}`);
    // ──────────────────────────────────────────────────────────────────────

    const {name,minChg,minVol}=tier;
    const rej={pct:0,pl:0,ph:0,vol:0,otc:0,etf:0,bad:0};
    const newGappers=[...merge.values()].filter(t=>{
      if(t.chgPct <minChg)    {rej.pct++; return false;}
      if(t.price  <0.10)      {rej.pl++;  return false;}
      if(t.price  >10&&t.chgPct<100){rej.ph++;return false;} // allow >$10 if ≥100% gain
      // Vol gate: absolute volume OR high-RVol bypass. Catches small-cap names
      // like IPHA (150x RVol on 1M absolute vol) that NuntioBot fires but pure
      // 5M-absolute gate would reject. RVol ≥ 3x with at least 100K liquidity
      // is enough signal to not be dust. PRE bypasses entirely (day.v=0 pre-market).
      const rvolBypass = t.rvol >= 3 && t.volume >= 100_000;
      if(minVol>0&&name!=='PRE'&&t.volume<minVol&&!rvolBypass){rej.vol++;return false;}
      if(t.isOTC)             {rej.otc++; return false;}
      if(isEtf(t.ticker))     {rej.etf++; return false;}
      if(isBadTicker(t.ticker)){rej.bad++;return false;}
      return true;
    }).sort((a,b)=>b.chgPct-a.chgPct).slice(0,50);

    console.log(`[${name}] from ${merge.size}: passed=${newGappers.length} | chg<${minChg}%:${rej.pct} p<0.10:${rej.pl} p>10:${rej.ph} vol:${rej.vol} OTC:${rej.otc} ETF:${rej.etf}`);
    if(newGappers.length>0)
      console.log(`[Gappers] ${newGappers.slice(0,5).map(g=>`${g.ticker}(${g.chgPct.toFixed(0)}%,${fmtN(g.volume)},${g.rvol.toFixed(1)}x)`).join(' ')}`);

    topGappers=newGappers;

    // Lock into dayWatchlist 4AM–4PM
    if(etMin>=240&&etMin<960){
      for(const g of topGappers){
        if(!dayWatchlist.has(g.ticker)){
          dayWatchlist.set(g.ticker,{ticker:g.ticker,chgPct:g.chgPct,volume:g.volume,
            rvol:g.rvol,price:g.price,high:g.high,lockedAt:name});
          recentRunners.set(g.ticker, Date.now());
          console.log(`[Watch] +${g.ticker} +${g.chgPct.toFixed(1)}% vol:${fmtN(g.volume)} [${name}]`);
        }
      }
    }

    for(const g of topGappers){
      const ex=state.tickers.get(g.ticker)||{high:0,nhod:0,lastAlertPrice:0,lastAlertTime:0,priceHistory:[]};
      // New ticker (ex.high===0): init from day.h to prevent false PMH hours after real peak
      // Existing ticker: keep max of current price and WS-tracked high
      const initHigh = ex.high>0 ? Math.max(g.price,ex.high) : Math.max(g.price,g.dayHigh||0);
      const peakVol = Math.max(g.volume||0, ex.peakVol||0);
      state.tickers.set(g.ticker,{...ex,...g,high:initHigh,peakVol});
    }
    for(const [ticker,g] of dayWatchlist){
      if(!state.tickers.has(ticker))
        state.tickers.set(ticker,{high:g.high,nhod:0,lastAlertPrice:0,lastAlertTime:0,priceHistory:[]});
    }
    // Ensure permanentWatch tickers always have a state entry
    for(const ticker of permanentWatch){
      if(!state.tickers.has(ticker))
        state.tickers.set(ticker,{high:0,nhod:0,lastAlertPrice:0,lastAlertTime:0,priceHistory:[]});
    }

    console.log(`[${timeStr}] ${topGappers.length} live | ${dayWatchlist.size} watchlist | ${name}`);
  }catch(e){console.error('[refreshGappers] CRASH:',e.message,e.stack);}
}

// ─── NHOD Alert ───────────────────────────────────────────────────────────────
async function fireNHOD(ticker,price){
  if(!isActive()) return;

  const liveG  =topGappers.find(g=>g.ticker===ticker);
  const watchG =dayWatchlist.get(ticker);
  const isPermW=permanentWatch.has(ticker);
  const gapper =liveG||watchG||(isPermW?{ticker,chgPct:0,volume:0,prevVol:0,rvol:0,price:0}:null);
  const isWatchOnly=!liveG&&(!!watchG||isPermW);
  if(!gapper) return;

  const s=state.tickers.get(ticker);
  if(!s)                  {console.log(`[NHOD] ${ticker} skip: no state`);return;}
  if(price<=s.high+0.001) {console.log(`[NHOD] ${ticker} skip: $${price.toFixed(4)} not above high $${s.high.toFixed(4)}`);return;}

  const {etMin,timeStr}=getET();
  if(price>10&&gapper.chgPct<100) {console.log(`[NHOD] ${ticker} skip: >$10 (chg ${gapper.chgPct.toFixed(0)}%<100%)`);return;}
  if(price<0.10) {console.log(`[NHOD] ${ticker} skip: <$0.10`);return;}

  // All tickers must pass session tier gates (permanentWatch = same as watchlist)
  const tier=getTier(etMin);
  if(!tier) return;
  let checkVol = Math.max(gapper.volume||0, s.peakVol||0);

  // Always freshen when not in current topGappers. dayWatchlist data is from
  // lock-time (could be hours stale). Synthetic permanentWatch gappers are
  // hardcoded zeros. Just always pull a fresh snapshot in this path — the
  // ~200ms cost is cheaper than missing alerts. liveG tickers skip this
  // (their data is from the most recent scanner cycle, ≤20s old).
  const needFreshen = !liveG;
  if(needFreshen){
    try {
      const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
      const td = snap && snap.ticker;
      if(td){
        const lastP = (td.lastTrade && td.lastTrade.p) || (td.day && td.day.c) || price;
        const prevC = (td.prevDay && td.prevDay.c) || 0;
        const dayV  = (td.day && td.day.v) || 0;
        const prevV = (td.prevDay && td.prevDay.v) || 0;
        const mins  = Math.max(etMin-240, 1);
        if(prevC > 0) gapper.chgPct = ((lastP - prevC) / prevC) * 100;
        gapper.price   = lastP;
        gapper.volume  = dayV;
        gapper.prevVol = prevV;
        gapper.rvol    = prevV > 0 ? (dayV*390)/(mins*prevV) : 0;
        if(dayV > 0){
          checkVol = Math.max(checkVol, dayV);
          s.peakVol = Math.max(s.peakVol||0, dayV);
        }
        console.log(`[NHOD] ${ticker} freshen: chg=${gapper.chgPct.toFixed(1)}% vol=${fmtN(dayV)} rvol=${gapper.rvol.toFixed(1)}x`);
      }
    } catch(e){ /* fall through; gates below will reject if data still bad */ }
  }
  if(tier.minVol>0){
    if(tier.name==='PRE'){
      // Pre-market: Polygon day.v is always 0 before open — don't penalize live scanner tickers
      // Only apply vol gate to watchlist-only tickers (they bypassed the scanner)
      // Watchlist tickers: block if NO volume at all (yesterday's ghosts)
      // Allow if they have ANY pre-market activity (peakVol or gapper.volume > 0)
      if(isWatchOnly && checkVol===0){
        console.log(`[NHOD] ${ticker} skip: PRE no volume (watch)`);return;
      }
    } else if(tier.name==='AH'){
      // AH: fresh names need 500K; day gainers with big peakVol bypass
      const isDayGapper = dayWatchlist.has(ticker)||(s.peakVol||0)>=500_000;
      if(!isDayGapper && checkVol<tier.minVol){
        console.log(`[NHOD] ${ticker} skip: AH vol ${fmtN(checkVol)}<${fmtN(tier.minVol)} (fresh)`);return;
      }
    } else {
      // MKT: vol gate with RVol bypass (mirrors scanner logic). A 150x-RVol
      // small-cap pump shouldn't be silenced just because absolute volume is
      // <5M. Require ≥3x RVol AND ≥100K abs vol for liquidity sanity.
      const liveRvolForGate = gapper.rvol || 0;
      const rvolBypass = liveRvolForGate >= 3 && checkVol >= 100_000;
      if(checkVol<tier.minVol && !rvolBypass){
        console.log(`[NHOD] ${ticker} skip: ${tier.name} vol ${fmtN(checkVol)}<${fmtN(tier.minVol)} (rvol=${liveRvolForGate.toFixed(1)}x)`);return;
      }
    }
  }
  // In AH: measure move from 4PM close price, not all-day chgPct.
  // Require ≥5% above 4PM close to confirm a real AH move.
  // If close price not captured yet, block entirely — too early to judge.
  if(tier.name==='AH'){
    const cp=closePrice.get(ticker)||0;
    if(cp===0){
      console.log(`[NHOD] ${ticker} skip: AH close price not captured yet`);return;
    }
    const ahMove=((price-cp)/cp)*100;
    if(ahMove<5){
      console.log(`[NHOD] ${ticker} skip: AH move ${ahMove.toFixed(1)}% from close $${cp.toFixed(4)} < 5%`);return;
    }
  } else if(gapper.chgPct<tier.minChg && gapper.rvol<3){
    // chgPct gate now has the same RVol bypass as the volume gate. A 7% gain
    // on 50x RVol is still a real event (the entire float is changing hands);
    // we shouldn't reject it just because it's under 10%. Only skip if BOTH
    // chgPct AND rvol are below threshold. Rejects boring drift cleanly.
    console.log(`[NHOD] ${ticker} skip: ${tier.name} chg ${gapper.chgPct.toFixed(1)}%<${tier.minChg}% AND rvol ${gapper.rvol.toFixed(1)}x<3x`);return;
  }

  // Tiered cooldown: HOT movers (top gainers / unusual volume) get a much
  // shorter throttle so multiple NHODs in tight succession all fire — MOBX,
  // FRMI, etc. Regular gappers stay on 5min to prevent noise. "Hot" =
  // chgPct ≥ 50% OR rvol ≥ 5x. Both criteria capture genuinely abnormal
  // activity (94% gainers, 5x+ relative volume); ordinary +10–20% movers
  // on near-average volume don't qualify and stay on the longer cooldown.
  const isHot = (gapper.chgPct >= 50) || (gapper.rvol >= 5);
  const cooldownMs = isHot ? 90*1000 : 5*60*1000;
  if(s.lastAlertTime>0&&Date.now()-s.lastAlertTime<cooldownMs){
    const ageSec = Math.round((Date.now()-s.lastAlertTime)/1000);
    console.log(`[NHOD] ${ticker} skip: ${isHot?'90s':'5min'} cooldown (last alert ${ageSec}s ago, hot=${isHot} chg=${gapper.chgPct.toFixed(0)}% rvol=${gapper.rvol.toFixed(1)}x)`);return;
  }

  const nhod=(s.nhod||0)+1;
  state.tickers.set(ticker,{...s,high:price,nhod,lastAlertPrice:price,lastAlertTime:Date.now(),priceHistory:s.priceHistory||[]});
  state.dailyCounts.set(ticker,(state.dailyCounts.get(ticker)||0)+1);
  console.log(`[ALERT] ↗ ${ticker} $${price.toFixed(4)} x${nhod}${isPermW?' [PERM]':isWatchOnly?' [watch]':''}`);

  // Fresh snapshot for live vol/rvol/chgPct
  const snap=await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
  const td=snap&&snap.ticker;
  const livePrice= (td&&td.lastTrade&&td.lastTrade.p)||(td&&td.day&&td.day.c)||price;
  const liveVol  = (td&&td.day&&td.day.v)||gapper.volume||0;
  const livePrev = (td&&td.prevDay&&td.prevDay.v)||gapper.prevVol||0;
  const livePct  = (()=>{const p=livePrice;const pv=(td&&td.prevDay&&td.prevDay.c)||0;return p&&pv?((p-pv)/pv)*100:gapper.chgPct;})();
  const liveRvol = livePrev>0?(liveVol*390)/(Math.max(etMin-240,1)*livePrev):gapper.rvol||0;

  // Parallel-fetch all enrichment data.
  const [newsUrl,rs,det,fv,greenBars,ctb]=await Promise.all([
    getNewsUrl(ticker),getRecentSplit(ticker),getTickerDetails(ticker),
    getFinvizStats(ticker),getGreenBars(ticker),getCTB(ticker),
  ]);

  const mc=det.market_cap||0;
  const rsStr=rs?` | ${rs}`:'';

  const hist=(state.tickers.get(ticker)||{}).priceHistory||[];
  let afterLull='';
  if(hist.length>=10){
    const old=hist.filter(h=>h.time<Date.now()-10*60*1000);
    if(old.length>=3){
      const oH=Math.max(...old.map(h=>h.price)),oL=Math.min(...old.map(h=>h.price));
      if((oH-oL)/oL<0.02&&price>oH*1.03) afterLull=' · `after-lull`';
    }
  }

  // tLink: bold ticker, made clickable when there's a recent news URL
  const tLink=newsUrl?`[**${ticker}**](<${newsUrl}>)`:`**${ticker}**`;

  // NuntioBot exact format (verified against 5 screenshots 2026-05-14):
  // `09:44` ↗ **CREG** <$.50c · 1 `NHOD` ~ 🇨🇳 | **RVol:** 6.0x | `Reg SHO` | `High CTB`
  // `08:55` ↗ **MOBX** <$3 `47%` · 7 `3 green bars 1m` ~ 🇺🇸 | **RVol:** 1.8x | **Vol:** 5.7 M | **SI:** 16.1% | [`PR`↗](url)
  //   time-pill  bold-ticker  PLAIN-price  pct-pill  · count  label-pill  ~ flag  | **labels:** vals | regSHO | CTB | PR
  const timeShort = timeStr.slice(0,5);
  const pctCode   = livePct!==0 ? ` \`${Math.abs(livePct).toFixed(0)}%\`` : '';
  const afterStr  = afterLull ? ` after-lull` : '';
  // Count is ALWAYS followed by a label pill. Green-bars pill takes priority over NHOD when present.
  const labelStr  = greenBars.count>=2
    ? `\`${greenBars.count} green bars ${greenBars.timeframe}\``
    : '`NHOD`';
  const rvolStr   = liveRvol>0 ? ` | **RVol:** ${fmtRVol(liveRvol)}` : '';
  const volStr    = liveVol>0  ? ` | **Vol:** ${fmtNS(liveVol)}` : '';
  const siStr     = fv.si!=='--' ? ` | **SI:** ${fv.si}` : '';
  // Reg SHO: authoritative match against the daily NYSE+NASDAQ threshold list
  const regSHOStr = isRegSHO(ticker) ? ' | `Reg SHO`' : '';
  // High CTB: borrow fee >= 20% per annum (industry rough threshold for "hard to borrow")
  const ctbStr    = (ctb && ctb.fee >= 20) ? ' | `High CTB`' : '';
  const prData2   = newsCache.get(ticker);
  const prLink    = prData2&&(Date.now()-(prData2.ts||0))<24*60*60*1000&&prData2.url ? ` | [\`PR\`↗](<${prData2.url}>)` : '';
  const line = `\`${timeShort}\` ↗ ${tLink} ${priceFlag(price)}${pctCode} · ${nhod} ${labelStr}${afterStr} ~ ${flag(ticker)}${rvolStr}${volStr}${siStr}${regSHOStr}${ctbStr}${rsStr}${prLink}`;

  await post({content:line});
  console.log(`[ALERT] posted OK`);
}

// ─── News / PR alerts ─────────────────────────────────────────────────────────
const DROP_RE =/offering|public offering|convertible|shelf|ATM offering|at-the-market|direct offering|registered direct|dilut|warrant|prospectus|424B|S-1|S-3|secondary offering|note offering|senior notes|debenture|equity financ|private placement|underwritten|priced offering|prices offering/i;
const SPIKE_RE=/collaboration|agreement|partnership|FDA|approval|cleared|grant|award|contract|trial|data|results|positive|breakthrough|milestone|license|acqui|merger|acquisition|joint venture|\bJV\b|phase|cohort|study|efficacy|safety|quarterly|financial results|earnings|revenue|guidance|raises|secures|closes|signs|launches|wins|receives|completes|announces/i;

async function handleNewsItem(title,tickers,url,published_utc){
  if(!title||!tickers.length) return;
  const id=(url||title).slice(0,100);
  if(state.sentNews.has(id)) return;
  state.sentNews.add(id);
  for(const t of tickers) if(url) newsCache.set(t,{url,ts:Date.now()});
  const isDrop=DROP_RE.test(title);
  const isSpike=!isDrop&&SPIKE_RE.test(title);
  if(isDrop||isSpike) console.log(`[News] ${isDrop?'DROP':'SPIKE'} match: ${tickers.slice(0,3).join(',')} — ${title.slice(0,80)}`);
  if(!isDrop&&!isSpike) return;

  const {etMin}=getET();
  const tier=getTier(etMin);
  const prVolMin = tier ? (tier.name==='MKT' ? 50_000 : 0) : 0;

  // Fire for any stock matching keywords — no watchlist filter on news
  // DROP_RE/SPIKE_RE keywords are specific enough to avoid spam
  for(const ticker of tickers.slice(0,3)){
    if(isBadTicker(ticker)||isEtf(ticker)) continue;
    const prId=`${isDrop?'drop':'spike'}_${id}_${ticker}`;
    if(state.sentPR.has(prId)) continue;
    state.sentPR.add(prId);

    // Quick gate — make sure ticker is tracked and within price/volume limits
    const snap=await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
    const td=snap&&snap.ticker;
    const vol=(td&&td.day&&td.day.v)||0;
    const price=(td&&td.lastTrade&&td.lastTrade.p)||(td&&td.day&&td.day.c)||0;
    const isTracked = topGappers.some(g=>g.ticker===ticker)
                   || dayWatchlist.has(ticker)
                   || recentRunners.has(ticker)
                   || permanentWatch.has(ticker);
    if(!td||vol<prVolMin||price<0.10||price>30||!isTracked) continue;

    // Post instantly — no aggregation buffer
    postEventAlert(ticker, {
      type: 'PR',
      title: title.slice(0, 200),
      url,
      publishedTime: published_utc,
      isDrop,
    }).catch(e => console.error(`[postEventAlert PR] ${ticker}:`, e.message));
  }
  if(state.sentNews.size>500){const a=[...state.sentNews];state.sentNews.clear();a.slice(-200).forEach(x=>state.sentNews.add(x));}
  if(state.sentPR.size>500){const a=[...state.sentPR];state.sentPR.clear();a.slice(-200).forEach(x=>state.sentPR.add(x));}
}

// ─── Benzinga WS (disabled) ───────────────────────────────────────────────────
let wsBZ=null;
function connectBZ(){
  if(wsBZ){try{wsBZ.terminate();}catch(e){}}
  wsBZ=new WebSocket(`wss://api.benzinga.com/api/v1/news/stream?token=${BZ_KEY}`);
  wsBZ.on('open',()=>{console.log('[BZ] Connected');wsBZ._ping=setInterval(()=>{if(wsBZ.readyState===WebSocket.OPEN)wsBZ.send(JSON.stringify({action:'ping'}));},30000);});
  wsBZ.on('message',data=>{try{const msg=JSON.parse(data.toString());if(msg.kind==='news'&&msg.data&&msg.data.content){const n=msg.data.content;const t=(n.stocks||[]).map(s=>s.name||'').filter(Boolean).map(t=>t.toUpperCase());if(t.length)handleNewsItem(n.title||'',t,n.url||'',n.created||'').catch(()=>{});}}catch(e){}});
  wsBZ.on('error',err=>console.error('[BZ] Error:',err.message));
  wsBZ.on('close',()=>{if(wsBZ._ping)clearInterval(wsBZ._ping);setTimeout(connectBZ,10000);});
}

let lastNewsPoll=0;
async function pollNews(){
  if(!isActive()) return;
  if(Date.now()-lastNewsPoll<5000) return;
  lastNewsPoll=Date.now();
  try{
    const r=await polyGet('/v2/reference/news?limit=50&order=desc&sort=published_utc');
    const items=(r&&r.results)||[],cutoff=Date.now()-15*60*1000;
    let matched=0;
    for(const n of items){
      if(!n.published_utc||new Date(n.published_utc).getTime()<cutoff) continue;
      await handleNewsItem(n.title||'',(n.tickers||[]).filter(Boolean).map(t=>t.toUpperCase()),n.article_url||'',n.published_utc);
      matched++;
    }
    if(matched>0) console.log(`[Poly News] ${matched} items processed`);
  }catch(e){console.error('[Poly News] error:',e.message);}
}

// ─── SEC filings ──────────────────────────────────────────────────────────────
let lastFilingCheck=0;
async function checkFilings(){
  if(!isActive()) return;
  if(Date.now()-lastFilingCheck<2*60*1000) return;
  lastFilingCheck=Date.now();
  const known=new Set([...topGappers.map(g=>g.ticker),...dayWatchlist.keys(),...recentRunners.keys(),...permanentWatch]);
  if(!known.size) return;
  for(const ticker of known){
    try{
      const r=await polyGet(`/vX/reference/filings?ticker=${ticker}&limit=5&order=desc&sort=filed_at`);
      for(const f of (r&&r.results||[])){
        const filed=new Date(f.filed_at||0).getTime();
        const id=(f.filing_url||f.accession_number||'').slice(0,80);
        if(filed<=Date.now()-15*60*1000||state.sentFilings.has(id)) continue;
        state.sentFilings.add(id);
        const ft=(f.form_type||'SEC').toUpperCase();
        // Post instantly — no aggregation buffer
        postEventAlert(ticker, {
          type: 'SEC',
          title: `Form ${ft}`,
          url: f.filing_url,
          publishedTime: f.filed_at,
          isDrop: false,
        }).catch(e => console.error(`[postEventAlert SEC] ${ticker}:`, e.message));
      }
    }catch(e){}
    await sleep(200);
  }
}

// ─── Halt + Resume alerts (NASDAQ RSS) ────────────────────────────────────────
// NASDAQ Trader publishes a free, real-time RSS feed of all US equity trade
// halts. Polled every 5s (own setInterval, decoupled from main loop). Alerts:
//   - new halts: tracked tickers OR small-caps under $20 (catches new movers)
//   - resumes: detected two ways — scheduled resume time has passed, OR the
//     halt entry has DISAPPEARED from the RSS (the feed only lists currently-
//     halted issues, so disappearance = resumed)
//
// Critical correctness fixes 2026-05-14:
//   - Use haltTime from RSS as the displayed timestamp (not detection time)
//   - Suppress duplicate resume alert if halt is already over at first sight
//   - First poll after restart only sets a baseline — no alerts fired for
//     halts that were already in effect before we came online
// Format matches NuntioBot style: time-with-seconds + direction (UP/DOWN) for
// volatility halts. Trader-relevant codes only.
const HALT_ALERT_CODES = new Set(['T1','T2','T5','T12','LUDP','H10','H11']);
// Short labels for display — long names go in console logs only
const HALT_REASON_SHORT = {
  'T1':  'News Pending',
  'T2':  'News Released',
  'T5':  'Volatility',
  'T12': 'Info Requested',
  'LUDP':'Volatility',
  'H10': 'SEC Suspension',
  'H11': 'Regulatory',
};
// Codes where direction (UP/DOWN) is meaningful — price hit a limit band
const HALT_DIRECTIONAL = new Set(['T5','LUDP','LUDS']);

// haltState: composite key → {ticker, code, reason, haltedAt, resumeAt,
//                              haltTimeOriginal, resumeTimeOriginal,
//                              alertedHalt, alertedResume}
const haltState = new Map();
// Tickers currently in the RSS feed (rebuilt each poll). Used to detect
// resumes: keys in PREVIOUS set but not in CURRENT set = resumed.
let currentlyHalted = new Set();
let lastHaltPoll = 0;
// First poll after startup just sets a baseline — don't alert on halts that
// were already in effect before we came online. Prevents restart noise.
let firstHaltPoll = true;

// Parse "MM/DD/YYYY" + "HH:MM:SS" (NASDAQ publishes everything in ET) into
// UTC ms for comparison with Date.now(). DST handled approximately — sub-day
// drift is irrelevant for halt-recency math.
function parseEtToUtcMs(dateStr, timeStr){
  if(!dateStr || !timeStr) return 0;
  try {
    const [mm, dd, yyyy] = dateStr.split('/').map(Number);
    const [h, m, s] = timeStr.split(':').map(Number);
    if(!yyyy || isNaN(h)) return 0;
    const utcWall = Date.UTC(yyyy, mm-1, dd, h, m||0, s||0);
    // US Eastern DST: 2nd Sun Mar → 1st Sun Nov. Approximation good to ±a week.
    const isDST = (mm > 3 && mm < 11) || (mm === 3 && dd >= 14) || (mm === 11 && dd < 7);
    return utcWall + (isDST ? 4 : 5) * 3600 * 1000;
  } catch(e){ return 0; }
}

async function pollHalts(){
  // Internal throttle: 5s minimum between fetches (matches setInterval cadence)
  if(Date.now() - lastHaltPoll < 5_000) return;
  lastHaltPoll = Date.now();
  try {
    const xml = await rawGet('https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts', {
      'User-Agent': 'AziziBot/1.0',
      'Accept': 'application/rss+xml, text/xml, */*',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    });
    if(!xml || xml.length < 200) return;
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    const nowHalted = new Set();
    let newHalts = 0, resumes = 0, baselined = 0;

    // First pass: parse all items, register new halts, fire halt alerts
    for(const itemXml of items){
      const grab = (re) => { const x = itemXml.match(re); return x ? x[1].trim() : ''; };
      const ticker = grab(/<ndaq:IssueSymbol[^>]*>([^<]+)<\/ndaq:IssueSymbol>/i).toUpperCase();
      const code = grab(/<ndaq:ReasonCode[^>]*>([^<]+)<\/ndaq:ReasonCode>/i).toUpperCase();
      if(!ticker || !code) continue;
      if(!HALT_ALERT_CODES.has(code)) continue;

      const haltDate   = grab(/<ndaq:HaltDate[^>]*>([^<]+)<\/ndaq:HaltDate>/i);
      const haltTime   = grab(/<ndaq:HaltTime[^>]*>([^<]+)<\/ndaq:HaltTime>/i);
      const resumeDate = grab(/<ndaq:ResumptionDate[^>]*>([^<]+)<\/ndaq:ResumptionDate>/i);
      const resumeTime = grab(/<ndaq:ResumptionTradeTime[^>]*>([^<]+)<\/ndaq:ResumptionTradeTime>/i)
                       || grab(/<ndaq:ResumptionQuoteTime[^>]*>([^<]+)<\/ndaq:ResumptionQuoteTime>/i);

      const haltedAt = parseEtToUtcMs(haltDate, haltTime);
      const resumeAt = parseEtToUtcMs(resumeDate, resumeTime);
      const key = `${ticker}_${haltDate}_${haltTime}`;
      nowHalted.add(key);

      let st = haltState.get(key);
      if(!st){
        st = {
          ticker, code,
          reason: HALT_REASON_SHORT[code] || code,
          haltedAt: haltedAt || Date.now(),
          resumeAt,
          haltTimeOriginal: haltTime,      // ← actual halt time string for display
          resumeTimeOriginal: resumeTime,
          alertedHalt: false,    // have we evaluated this halt yet?
          firedHaltAlert: false, // did we actually post a halt alert?
          alertedResume: false,  // have we evaluated/fired the resume?
        };
        haltState.set(key, st);

        // First-poll-after-restart baseline: mark the halt as evaluated (don't
        // fire stale halt alerts) BUT leave alertedResume=false so the resume
        // can still fire when the stock comes back online — important for
        // tickers like TDIC that were halted during a deploy/restart.
        if(firstHaltPoll){
          st.alertedHalt = true;
          // st.firedHaltAlert stays false → resume will re-check qualification
          // st.alertedResume stays false → resume can still fire
          baselined++;
          continue;
        }
      } else if(resumeAt > 0 && !st.resumeAt){
        // Resume time was just announced — store but don't re-alert on halt
        st.resumeAt = resumeAt;
        st.resumeTimeOriginal = resumeTime;
      }

      if(!st.alertedHalt){
        const should = await shouldAlertHalt(ticker);
        if(should){
          await fireHaltAlert(st);
          st.firedHaltAlert = true;
          newHalts++;
        }
        st.alertedHalt = true; // mark even if we didn't alert (avoids re-eval)

        // CRITICAL: if the halt is ALREADY over at first detection (we were
        // late), suppress the resume alert entirely. The halt message already
        // shows "Resume HH:MM ET" so the user knows it's resolved. Without
        // this, halt + resume fire back-to-back for stale halts.
        if(st.resumeAt > 0 && Date.now() >= st.resumeAt){
          st.alertedResume = true;
        }
      }

      // Resume alert path 1: scheduled resume time passed.
      // Fires if EITHER (a) we previously posted the halt alert (consistency)
      // OR (b) the ticker currently qualifies (catches restart-baselined cases
      // like TDIC where we missed the halt but the ticker is a huge mover).
      if(!st.alertedResume && st.resumeAt > 0 && Date.now() >= st.resumeAt){
        const should = st.firedHaltAlert || await shouldAlertHalt(st.ticker);
        if(should){
          await fireResumeAlert(st);
          resumes++;
        }
        st.alertedResume = true;
      }
    }

    // Second pass: items in PREVIOUS poll but NOT in this one = disappeared
    // from RSS = resumed. Catches resumes when the RSS never published a
    // resume time. Skip on first poll (no prior set to compare against).
    // Same fire-criteria as path 1: posted halt alert OR currently qualifies.
    if(!firstHaltPoll){
      for(const key of currentlyHalted){
        if(!nowHalted.has(key)){
          const st = haltState.get(key);
          if(st && !st.alertedResume){
            const should = st.firedHaltAlert || await shouldAlertHalt(st.ticker);
            if(should){
              await fireResumeAlert(st);
              resumes++;
            }
            st.alertedResume = true;
          }
        }
      }
    }
    currentlyHalted = nowHalted;
    if(firstHaltPoll){
      console.log(`[Halts] startup baseline: ${baselined} pre-existing halt(s) skipped`);
      firstHaltPoll = false;
    } else if(newHalts || resumes) {
      console.log(`[Halts] ${newHalts} halt(s), ${resumes} resume(s)`);
    }
    // Prune state older than 24h
    const cutoff = Date.now() - 24*60*60*1000;
    for(const [k, st] of haltState){
      if((st.haltedAt || 0) < cutoff) haltState.delete(k);
    }
  } catch(e){
    console.error('[Halts] error:', e.message);
  }
}

// Decide whether to fire a halt/resume alert for this ticker.
//
// ALWAYS alert for tracked tickers (topGappers, dayWatchlist, permanentWatch)
// since those are explicitly on our radar.
//
// For UNTRACKED tickers, require ALL of:
//   - moving meaningfully (|chgPct| ≥ 5%) — a real mover, not noise
//   - liquid (today's volume ≥ 1M shares AND today's dollar volume ≥ $2M)
//   - reasonable price range ($0.50–$50)
//   - not OTC / ETF / bad ticker pattern
// Filters out illiquid microcap LUDPs (SRL/TCGL/JMG class) that LUDP'd on a
// 5K-share spike — those halts/resumes aren't actionable.
async function shouldAlertHalt(ticker){
  if(topGappers.some(g => g.ticker === ticker) ||
     dayWatchlist.has(ticker) ||
     permanentWatch.has(ticker)){
    return true;
  }
  if(isBadTicker(ticker) || isEtf(ticker)) return false;
  try {
    const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
    const td = snap && snap.ticker;
    if(!td) return false;
    const isOTC = /OTC|GREY|PINK|EXPERT/i.test(td.primaryExchange || '');
    if(isOTC) return false;

    const price   = (td.lastTrade && td.lastTrade.p) || (td.day && td.day.c) || 0;
    const dayVol  = (td.day && td.day.v) || 0;
    const chgPct  = (typeof td.todaysChangePerc === 'number') ? td.todaysChangePerc : 0;
    const dollarVol = dayVol * price;

    // Price range — kept slightly wider than before ($50 ceiling) to catch
    // mid-cap halts on real catalysts, but with the liquidity guard below.
    if(price < 0.50 || price > 50) return false;
    // Real mover today, not just noise that touched a limit band
    if(Math.abs(chgPct) < 5) return false;
    // Liquidity floor — both share volume AND dollar volume must clear bar
    if(dayVol < 1_000_000) return false;
    if(dollarVol < 2_000_000) return false;
    return true;
  } catch(e){ return false; }
}

// Pull fresh price/volume/change for a halted ticker. Returns null on failure.
async function snapForHalt(ticker){
  try {
    const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
    const td = snap && snap.ticker;
    if(!td) return null;
    const price = (td.lastTrade && td.lastTrade.p) || (td.day && td.day.c) || 0;
    const vol = (td.day && td.day.v) || 0;
    const chgPct = (typeof td.todaysChangePerc === 'number') ? td.todaysChangePerc : null;
    return { price, vol, chgPct };
  } catch(e){ return null; }
}

// Format halt alert in NuntioBot style:
//   `13:39:00` `FCUV` `Halted UP` 🇺🇸 | Volatility → $1.80 · 1.9M vol · Resume 13:44 ET
// Timestamp = actual halt time from RSS (not detection time).
async function fireHaltAlert(st){
  const {ticker, code, reason, haltTimeOriginal, resumeTimeOriginal} = st;
  // Use the actual halt time from the RSS feed — accurate to when the stock
  // halted, regardless of when we detected it.
  const timeStr = haltTimeOriginal || getET().timeStr;
  const s = await snapForHalt(ticker);

  // Direction for volatility halts: positive day change = halted at top of
  // band (UP), negative = halted at bottom (DOWN). Threshold ±0.5%.
  let haltLabel = 'Halted';
  if(HALT_DIRECTIONAL.has(code) && s && typeof s.chgPct === 'number'){
    if(s.chgPct > 0.5) haltLabel = 'Halted UP';
    else if(s.chgPct < -0.5) haltLabel = 'Halted DOWN';
  }

  // Compose right-of-pipe content
  const after = [];
  let mainPart = reason;
  if(s && s.price > 0){
    const priceStr = `$${s.price.toFixed(2)}`;
    const volStr = s.vol > 0 ? `${fmtNS(s.vol)} vol` : '';
    const tail = [priceStr, volStr].filter(Boolean).join(' · ');
    mainPart = `${reason} → ${tail}`;
  }
  after.push(mainPart);
  if(resumeTimeOriginal){
    after.push(`Resume ${resumeTimeOriginal.slice(0,5)} ET`);
  }

  const line = `\`${timeStr}\` \`${ticker}\` \`${haltLabel}\` ${flag(ticker)} | ${after.join(' · ')}`;
  await postHalt({content: line});
  console.log(`[Halt] 🛑 ${ticker} ${code} ${haltLabel} @ ${timeStr}`);
}

// Format resume alert in NuntioBot style (minimal):
//   `13:44:00` `FCUV` `Resumed` 🇺🇸
// Timestamp = scheduled resume time from RSS if known, else current time.
async function fireResumeAlert(st){
  const {ticker, code, resumeTimeOriginal} = st;
  const timeStr = resumeTimeOriginal || getET().timeStr;
  const line = `\`${timeStr}\` \`${ticker}\` \`Resumed\` ${flag(ticker)}`;
  await postHalt({content: line});
  console.log(`[Halt] ▶️ ${ticker} resumed (${code}) @ ${timeStr}`);
}

// ─── Session transition sync ──────────────────────────────────────────────────
// At 4PM (MKT→AH), capture the closing price for every tracked ticker.
// AH alerts only fire if price is ≥5% above the 4PM close price.
// This ensures only genuine AH movers fire, not stocks that ran during the day.
let lastTransitionSync = 0;
async function syncHighsAtTransition() {
  const {etMin} = getET();
  const inAH = etMin >= 960 && etMin < 1200;
  if(!inAH) return;
  if(Date.now() - lastTransitionSync < 60*60*1000) return;
  lastTransitionSync = Date.now();

  const tickers = [...new Set([...topGappers.map(g=>g.ticker), ...dayWatchlist.keys()])];
  if(!tickers.length) return;
  console.log(`[Transition] MKT→AH: capturing close prices for ${tickers.length} tickers...`);

  for(const ticker of tickers) {
    try {
      const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
      const td   = snap&&snap.ticker;
      const cur  = (td&&td.lastTrade&&td.lastTrade.p)||(td&&td.day&&td.day.c)||0;
      if(cur > 0) {
        closePrice.set(ticker, cur);
        const s = state.tickers.get(ticker);
        if(s) {
          state.tickers.set(ticker, {...s, high:cur, nhod:0, lastAlertPrice:0, lastAlertTime:0});
        }
        console.log(`[Transition] ${ticker} close=$${cur.toFixed(4)}`);
      }
    } catch(e) {}
    await sleep(100);
  }
  state.dailyCounts.clear();
  console.log(`[Transition] Done — AH baseline captured`);
}
async function checkMorningSnapshot(){
  if(!isMarketDay()) return;
  const {hh,m}=getET();
  if((hh!==6&&hh!==7)||m!==0) return;
  const key=`${new Date().toISOString().slice(0,10)}_${hh}`;
  if(state.morningPosted.has(key)||!topGappers.length) return;
  state.morningPosted.add(key);
  const rows=topGappers.map(g=>{
    const dot=g.chgPct>=200?'🔴':g.chgPct>=100?'🟠':g.chgPct>=50?'🟡':'🟢';
    return`${dot} **${g.ticker}** \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` | $${g.price.toFixed(4)} | Vol: ${fmtN(g.volume)} | RVol: ${fmtRVol(g.rvol)}`;
  }).join('\n');
  await post({embeds:[{title:`${hh===6?'🌅 6AM':'☀️ 7AM'} Pre-Market Gappers`,description:rows||'No data',color:0x00d4ff,footer:{text:`AziziBot · ${getET().timeStr} ET`},timestamp:new Date().toISOString()}]});
  console.log(`[${getET().timeStr}] Morning snapshot posted`);
}

// ─── Day-gapper recovery (restart resilience) ────────────────────────────────
// On startup, dayWatchlist is empty. Standard refreshGappers only catches
// tickers currently in top 50 by chgPct. A stock that pumped to +80% at 10AM
// but is now back to +20% might fall off top 50 and never re-enter tracking.
// This function scans current snapshot for ANY ticker whose intraday HIGH
// (day.h vs prevDay.c) was ≥10%, regardless of current chgPct. Re-locks them
// into dayWatchlist so we keep tracking. Only runs on startup — eats ~1s.
async function recoverDayGappers(){
  const {etMin} = getET();
  // Skip pre-market (day.h hasn't moved yet)
  if(etMin < 570) return;
  try {
    // Pull a wide net — top 500 by volume catches anything that traded heavily today
    const r = await polyGet('/v2/snapshot/locale/us/markets/stocks/tickers?sort=volume&direction=desc&limit=500');
    const tickers = (r && r.tickers) || [];
    let recovered = 0;
    for(const t of tickers){
      const symbol = t.ticker;
      if(!symbol || isBadTicker(symbol) || isEtf(symbol) || dayWatchlist.has(symbol)) continue;
      const prevC = (t.prevDay && t.prevDay.c) || 0;
      const dayH  = (t.day && t.day.h) || 0;
      const dayV  = (t.day && t.day.v) || 0;
      const dayC  = (t.day && t.day.c) || 0;
      if(prevC <= 0 || dayH <= 0 || dayV < 100_000) continue;
      // peakPct = highest gain achieved today (using day.h)
      const peakPct = ((dayH - prevC) / prevC) * 100;
      const curPct  = dayC > 0 ? ((dayC - prevC) / prevC) * 100 : peakPct;
      if(peakPct < 10) continue;
      // Skip OTC and >$10 stocks (matches scanner gates)
      const isOTC = /OTC|GREY|PINK|EXPERT/i.test(t.primaryExchange || '');
      if(isOTC) continue;
      if(dayH > 10) continue; // matches the $10 ceiling from scanner
      const curPrice = (t.lastTrade && t.lastTrade.p) || dayC || dayH;
      const mins = Math.max(etMin - 240, 1);
      const prevV = (t.prevDay && t.prevDay.v) || 0;
      const rvol = prevV > 0 ? (dayV * 390) / (mins * prevV) : 0;
      dayWatchlist.set(symbol, {
        ticker: symbol,
        chgPct: peakPct,         // use peak so cooldown tier "isHot" gets the truth
        volume: dayV,
        prevVol: prevV,
        rvol,
        price: curPrice,
        high: dayH,
        lockedAt: 'recovered',
      });
      recentRunners.set(symbol, Date.now());
      recovered++;
      if(recovered >= 100) break; // cap so we don't blow the WS subscription budget
    }
    console.log(`[Recovery] +${recovered} day-gappers recovered (intraday peak ≥10%, vol ≥100K)`);
  } catch(e) {
    console.error('[Recovery] error:', e.message);
  }
}

// ─── Price WebSocket ──────────────────────────────────────────────────────────
let ws=null;
const subscribedTickers=new Set();

function connectPriceWS(){
  if(ws){try{ws.terminate();}catch(e){}}
  console.log('[PriceWS] Connecting...');
  ws=new WebSocket('wss://socket.polygon.io/stocks');
  ws.on('open',()=>{console.log('[PriceWS] Open');ws.send(JSON.stringify({action:'auth',params:POLY_KEY}));});
  ws.on('message',data=>{
    try{
      for(const msg of JSON.parse(data.toString())){
        if(msg.ev==='status'){
          console.log(`[PriceWS] ${msg.status}: ${msg.message||''}`);
          if(msg.status==='auth_success'){
            subscribedTickers.clear();
            const keys=new Set([...topGappers.map(g=>g.ticker),...dayWatchlist.keys(),...permanentWatch]);
            const subs=[...keys].map(t=>`T.${t},A.${t}`).join(',');
            if(subs){ws.send(JSON.stringify({action:'subscribe',params:subs}));keys.forEach(t=>subscribedTickers.add(t));}
            console.log(`[PriceWS] Subscribed ${keys.size} (${topGappers.length} live + ${dayWatchlist.size} watch)`);
          }
          if(msg.status==='auth_failed') console.error('[PriceWS] AUTH FAILED — check POLY_KEY');
        }
        if(msg.ev==='T'||msg.ev==='A'){
          const ticker=msg.sym, price=msg.ev==='T'?msg.p:(msg.c||msg.h||0);
          if(!price||!ticker) continue;
          const liveG=topGappers.find(x=>x.ticker===ticker);
          const watchG=dayWatchlist.get(ticker);
          const permW=permanentWatch.has(ticker);
          if(!liveG&&!watchG&&!permW) continue;
          if(liveG&&(liveG.price>10||liveG.chgPct<5)) continue;
          const s=state.tickers.get(ticker);
          if(!s) continue;
          // Pull volume + daily high from A (per-minute aggregate) events.
          // av = accumulated daily volume. This is critical for watchlist-only
          // tickers that didn't pass the scanner this cycle — without it,
          // s.peakVol stays at the scanner value (often 0) and the vol gate
          // misfires. h = current minute high; used to bootstrap s.high when
          // state was just created and never seen a price yet.
          if(msg.ev==='A'){
            const av=+msg.av||0;
            if(av>(s.peakVol||0)) s.peakVol=av;
            const dh=+msg.h||0;
            if((!s.high||s.high===0)&&dh>0) s.high=dh;
          }
          if(!s.priceHistory) s.priceHistory=[];
          s.priceHistory.push({price,time:Date.now()});
          if(s.priceHistory.length>60) s.priceHistory.shift();
          const prevHigh=s.high;
          if(price>prevHigh+0.001){
            const last=wsDebounce.get(ticker)||0;
            if(Date.now()-last>10000){
              console.log(`[PriceWS] ${ticker} NEW HIGH $${price.toFixed(4)} (was $${prevHigh.toFixed(4)}) peakVol=${fmtN(s.peakVol||0)}`);
              wsDebounce.set(ticker,Date.now());
              fireNHOD(ticker,price).catch(e=>console.error(`[fireNHOD] ${ticker}:`,e.message));
            }
          }
        }
      }
    }catch(e){console.error('[PriceWS] parse error:',e.message);}
  });
  ws.on('error',err=>console.error('[PriceWS] error:',err.message));
  ws.on('close',code=>{console.log(`[PriceWS] closed (${code}), reconnecting...`);setTimeout(connectPriceWS,5000);});
}

function subscribeNewTickers(tickers){
  if(!ws||ws.readyState!==WebSocket.OPEN||!tickers.length) return;
  ws.send(JSON.stringify({action:'subscribe',params:tickers.map(t=>`T.${t},A.${t}`).join(',')}));
  tickers.forEach(t=>subscribedTickers.add(t));
  console.log(`[PriceWS] +subscribed: ${tickers.join(', ')}`);
  // PRE-WARM: fetch snapshot for each newly subscribed ticker so state.high
  // and state.peakVol are seeded BEFORE the first WS tick arrives. Closes
  // the race where a fresh subscription's first trade tick triggers fireNHOD
  // against an uninitialized state (s.high=0) — that path would either fire
  // a false NHOD or skip due to synthetic data. With pre-warm, state is
  // populated from day.h/day.v within ~200ms of subscribe, before any
  // meaningful tick volume arrives.
  for(const t of tickers){
    polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${t}`).then(snap => {
      const td = snap && snap.ticker;
      if(!td) return;
      const dayH = (td.day && td.day.h) || 0;
      const dayV = (td.day && td.day.v) || 0;
      const s = state.tickers.get(t) || {high:0,nhod:0,lastAlertPrice:0,lastAlertTime:0,priceHistory:[]};
      if(dayH > (s.high||0)) s.high = dayH;
      if(dayV > (s.peakVol||0)) s.peakVol = dayV;
      state.tickers.set(t, s);
    }).catch(()=>{ /* non-critical pre-warm; main snapshot fetch on fireNHOD will recover */ });
  }
}

// ─── Discord commands ─────────────────────────────────────────────────────────
async function buildQuoteEmbed(ticker){
  ticker=ticker.toUpperCase().trim();
  const [snap,det,fv,rs,newsR]=await Promise.all([
    polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`),
    getTickerDetails(ticker),getFinvizStats(ticker),getRecentSplit(ticker),
    polyGet(`/v2/reference/news?ticker=${ticker}&limit=10&order=desc&sort=published_utc`),
  ]);
  const td=snap&&snap.ticker;
  if(!td) return{content:`No data for **${ticker}**`};
  const price=(td.lastTrade&&td.lastTrade.p)||(td.day&&td.day.c)||0;
  const prev=(td.prevDay&&td.prevDay.c)||0;
  const chgPct=price&&prev?((price-prev)/prev)*100:0;
  const vol=(td.day&&td.day.v)||0,pv2=(td.prevDay&&td.prevDay.v)||0;
  const {etMin}=getET();
  const rvol=pv2>0?(vol*390)/(Math.max(etMin-240,1)*pv2):0;
  const mc=det.market_cap||0;
  const cutoff=Date.now()-30*24*60*60*1000;
  const news=((newsR&&newsR.results)||[]).filter(n=>n.published_utc&&new Date(n.published_utc).getTime()>cutoff).slice(0,5);
  const newsStr=news.map(n=>{const age=Date.now()-new Date(n.published_utc).getTime();const a=age<3600000?`${Math.round(age/60000)}m`:age<86400000?`${Math.round(age/3600000)}h`:`${Math.round(age/86400000)}d`;return`• [${(n.title||'').slice(0,80)}](<${n.article_url||''}>) — *${a} ago*`;}).join('\n')||'No recent news';
  const fields=[
    {name:'Price',value:`$${price.toFixed(4)} ${chgPct>=0?'▲':'▼'} \`${chgPct>=0?'+':''}${chgPct.toFixed(2)}%\``,inline:true},
    {name:'Volume',value:fmtN(vol),inline:true},{name:'RVol',value:fmtRVol(rvol),inline:true},
    {name:'Market Cap',value:mc>0?fmtN(mc):'--',inline:true},{name:'Float',value:fv.float,inline:true},
    {name:'SI%',value:fv.si,inline:true},{name:'IO%',value:fv.io,inline:true},
    {name:'Prev Close',value:`$${prev.toFixed(4)}`,inline:true},
    {name:'Day High',value:`$${((td.day&&td.day.h)||0).toFixed(4)}`,inline:true},
  ];
  if(rs) fields.push({name:'Recent Split',value:rs,inline:false});
  fields.push({name:'Latest News (30d)',value:newsStr,inline:false});
  return{embeds:[{title:`${ticker} — ${det.name||ticker}`,color:chgPct>=0?0x26a641:0xe03e3e,fields,footer:{text:`AziziBot · ${getET().timeStr} ET`},timestamp:new Date().toISOString()}]};
}

async function handleCmd(cmd,option,interaction){
  await discordRest('POST',`/interactions/${interaction.id}/${interaction.token}/callback`,{type:5});
  let reply={content:'Unknown command'};
  try{
    if(cmd==='quote'||cmd==='q') reply=await buildQuoteEmbed(option);
    else if(cmd==='gappers'){
      const live=topGappers,watched=[...dayWatchlist.values()].filter(w=>!live.find(g=>g.ticker===w.ticker));
      const all=[...live,...watched];
      if(!all.length){reply={content:'No tracked names right now.'};}
      else{
        const rows=all.map(g=>`${!live.find(x=>x.ticker===g.ticker)?'👁':'🔥'} **${g.ticker}** \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` | Vol: ${fmtN(g.volume)}${g.lockedAt?` [${g.lockedAt}]`:''}`).join('\n');
        reply={embeds:[{title:`🔥 Live: ${live.length} | 👁 Watch: ${dayWatchlist.size}`,description:rows.slice(0,3900),color:0x00d4ff,footer:{text:`AziziBot · ${getET().timeStr} ET`}}]};
      }
    }
    else if(cmd==='news'){const ticker=option.toUpperCase();const r=await polyGet(`/v2/reference/news?ticker=${ticker}&limit=10&order=desc&sort=published_utc`);const cutoff=Date.now()-30*24*60*60*1000;const items=((r&&r.results)||[]).filter(n=>n.published_utc&&new Date(n.published_utc).getTime()>cutoff).slice(0,8);if(!items.length)reply={content:`No recent news for **${ticker}**.`};else{const rows=items.map(n=>{const age=Date.now()-new Date(n.published_utc).getTime();const a=age<3600000?`${Math.round(age/60000)}m`:age<86400000?`${Math.round(age/3600000)}h`:`${Math.round(age/86400000)}d`;return`• [${(n.title||'').slice(0,90)}](<${n.article_url||''}>) — *${a} ago*`;}).join('\n');reply={embeds:[{title:`📰 ${ticker} — Latest News`,description:rows,color:0x5865f2,footer:{text:`AziziBot · ${getET().timeStr} ET`}}]};}}
    else if(cmd==='si'||cmd==='float'){const ticker=option.toUpperCase();const [fv,det]=await Promise.all([getFinvizStats(ticker),getTickerDetails(ticker)]);const mc=det.market_cap||0;reply={embeds:[{title:`📊 ${ticker} — SI & Float`,color:0xf0a500,fields:[{name:'Short Interest %',value:fv.si,inline:true},{name:'Float',value:fv.float,inline:true},{name:'IO%',value:fv.io,inline:true},{name:'Market Cap',value:mc>0?fmtN(mc):'--',inline:true}],footer:{text:`AziziBot · ${getET().timeStr} ET`}}]};}
    else if(cmd==='filings'){const ticker=option.toUpperCase();const r=await polyGet(`/vX/reference/filings?ticker=${ticker}&limit=8&order=desc&sort=filed_at`);const filings=(r&&r.results)||[];if(!filings.length)reply={content:`No filings for **${ticker}**`};else{const rows=filings.map(f=>{const ft=(f.form_type||'').toUpperCase();const d=f.filed_at?new Date(f.filed_at).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';return`${/S-3|S-1|424B|8-K/.test(ft)?'⚠️':'📋'} **${ft}** ${d}${f.filing_url?` · [Link](<${f.filing_url}>)`:''}`}).join('\n');reply={embeds:[{title:`📋 ${ticker} — SEC Filings`,description:rows,color:0x7289da,footer:{text:`AziziBot · ${getET().timeStr} ET`}}]};}}
  }catch(e){reply={content:`Error: ${e.message}`};}
  await discordRest('PATCH',`/webhooks/${APP_ID}/${interaction.token}/messages/@original`,reply);
}

// ─── Discord Gateway ──────────────────────────────────────────────────────────
let wsDiscord=null, discordHB=null, discordSeq=null;
let discordSessionId=null, discordResumeUrl=null, discordHbAck=true;
let discordFailCount=0, discordLastConnect=0;
const DISCORD_MAX_BACKOFF=5*60*1000; // 5 min max backoff

function connectDiscord(resume=false){
  if(wsDiscord){try{wsDiscord.terminate();}catch(e){}}
  const url=(resume&&discordResumeUrl)||'wss://gateway.discord.gg/?v=10&encoding=json';
  wsDiscord=new WebSocket(url);
  wsDiscord.on('open',()=>console.log(`[Discord] Connected${resume?' (resume)':''}`));
  wsDiscord.on('message',async data=>{
    try{
      const msg=JSON.parse(data.toString());
      if(msg.s) discordSeq=msg.s;
      if(msg.op===10){
        // Hello — start heartbeat with jitter then identify or resume
        if(discordHB) clearInterval(discordHB);
        discordHbAck=true;
        // Send first heartbeat immediately, then on interval
        const hbInterval = msg.d.heartbeat_interval;
        let missedAcks = 0;
        if(discordHB) clearInterval(discordHB);
        discordHbAck = true;
        discordHB = setInterval(()=>{
          if(!discordHbAck){
            missedAcks++;
            if(missedAcks>=2){
              console.log('[Discord] Heartbeat ACK missed twice — reconnecting');
              missedAcks=0;
              clearInterval(discordHB);
              discordHB=null;
              try{wsDiscord.terminate();}catch(e){}
              return;
            }
          } else {
            missedAcks=0;
          }
          discordHbAck=false;
          if(wsDiscord&&wsDiscord.readyState===WebSocket.OPEN)
            wsDiscord.send(JSON.stringify({op:1,d:discordSeq}));
        }, hbInterval);

        if(resume&&discordSessionId&&discordSeq){
          // Resume existing session
          wsDiscord.send(JSON.stringify({op:6,d:{token:DISCORD_TOKEN,session_id:discordSessionId,seq:discordSeq}}));
        } else {
          // Fresh identify
          wsDiscord.send(JSON.stringify({op:2,d:{token:DISCORD_TOKEN,intents:(1<<9)|(1<<15),properties:{os:'linux',browser:'azizibot',device:'azizibot'}}}));
        }
      }
      if(msg.op===11) discordHbAck=true; // Heartbeat ACK
      if(msg.op===7)  { console.log('[Discord] Reconnect requested'); setTimeout(()=>connectDiscord(true),1000); }
      if(msg.op===9)  { console.log('[Discord] Invalid session'); discordSessionId=null; setTimeout(()=>connectDiscord(false),5000); }
      if(msg.op===0){
        if(msg.t==='READY'){
          discordSessionId=msg.d.session_id;
          discordResumeUrl=msg.d.resume_gateway_url;
          discordFailCount=0; // reset backoff on successful connect
          discordLastConnect=Date.now();
          console.log(`[Discord] Ready as ${msg.d.user.username}`);
        }
        if(msg.t==='RESUMED'){discordFailCount=0;console.log('[Discord] Session resumed');}
        if(msg.t==='INTERACTION_CREATE'&&msg.d.type===2){const cmd=msg.d.data.name;const opt=(msg.d.data.options&&msg.d.data.options[0]&&msg.d.data.options[0].value)||'';handleCmd(cmd,opt,msg.d).catch(e=>console.error('[Discord] cmd:',e.message));}
        if(msg.t==='MESSAGE_CREATE'&&!msg.d.author.bot){const m=(msg.d.content||'').trim().match(/^\$?([A-Z]{1,5})$/);if(m)buildQuoteEmbed(m[1]).then(e=>discordRest('POST',`/channels/${msg.d.channel_id}/messages`,e)).catch(()=>{});}
      }
    }catch(e){}
  });
  wsDiscord.on('error',err=>console.error('[Discord] error:',err.message));
  wsDiscord.on('close',code=>{
    if(discordHB){clearInterval(discordHB);discordHB=null;}
    console.log(`[Discord] closed (${code})`);
    if(code===4004){console.error('[Discord] Bad token — update DISCORD_TOKEN in Railway');setTimeout(()=>connectDiscord(false),30000);return;}
    // Try to resume on abnormal close, fresh connect otherwise
    // 1000/1001 = clean close → fresh IDENTIFY with backoff
    // 1006/4000 = abnormal close → RESUME (does NOT burn session limit)
    // 4004/4014 = auth error → long delay, no resume
    const canResume = !!(discordSessionId && discordSeq &&
                      code !== 1000 && code !== 1001 &&
                      code !== 4004 && code !== 4014);

    if(code===4004){
      console.error('[Discord] Bad token — update DISCORD_TOKEN in Railway. Pausing 5min.');
      setTimeout(()=>connectDiscord(false), 5*60*1000);
      return;
    }

    // Exponential backoff: 5s, 10s, 20s, 40s... max 5min
    // RESUME does not count against session_start_limit so backoff only for fresh connects
    discordFailCount++;
    const backoff = canResume ? 3000 : Math.min(5000 * Math.pow(2, discordFailCount-1), DISCORD_MAX_BACKOFF);
    console.log(`[Discord] closed (${code}) → ${canResume?'RESUME':'IDENTIFY (#'+discordFailCount+')'} in ${Math.round(backoff/1000)}s`);
    setTimeout(()=>connectDiscord(canResume), backoff);
  });
}

async function registerCommands(){
  const cmds=[
    {name:'quote',description:'Full quote card',options:[{type:3,name:'ticker',description:'Ticker',required:true}]},
    {name:'gappers',description:'Live gappers + full day watchlist'},
    {name:'news',description:'Latest news',options:[{type:3,name:'ticker',description:'Ticker',required:true}]},
    {name:'si',description:'Short interest & float',options:[{type:3,name:'ticker',description:'Ticker',required:true}]},
    {name:'float',description:'Float & short interest',options:[{type:3,name:'ticker',description:'Ticker',required:true}]},
    {name:'filings',description:'SEC filings',options:[{type:3,name:'ticker',description:'Ticker',required:true}]},
  ];
  try{const r=await discordRest('PUT',`/applications/${APP_ID}/commands`,cmds);console.log(`[Discord] ${Array.isArray(r)?r.length:0} commands registered`);}
  catch(e){console.error('[Discord] register:',e.message);}
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(){
  if(!POLY_KEY)      {console.error('FATAL: POLY_KEY missing');process.exit(1);}
  if(!DISCORD_TOKEN) {console.error('FATAL: DISCORD_TOKEN missing');process.exit(1);}
  console.log('🤖 AziziBot v8 starting...');
  console.log('[Tiers] PRE 4-9:30AM ≥10%/100K | MKT ≥10%/5M | AH ≥10%/500K(fresh only)');
  console.log(`[Polygon] key: ${POLY_KEY.slice(0,8)}...`);
  console.log(`[Halts] webhooks: ${HALT_ALERT_WHS.length ? `${HALT_ALERT_WHS.length} channel(s) configured` : 'NONE → halt alerts SUPPRESSED'}`);

  // Check Discord session_start_limit before connecting
  try{
    const gwData = await discordRest('GET', '/gateway/bot');
    const lim = gwData.session_start_limit;
    if(lim){
      console.log(`[Discord] Gateway: sessions remaining=${lim.remaining}/${lim.total} reset_after=${Math.round(lim.reset_after/60000)}min`);
      if(lim.remaining < 10) console.warn('[Discord] WARNING: session_start_limit nearly depleted!');
    }
  }catch(e){}

  // Test Polygon short interest endpoint on startup
  try {
    const testSI = await polyGet('/stocks/v1/short-interest?ticker=AAPL&limit=1&sort=settlement_date.desc');
    if(testSI && Array.isArray(testSI.results) && testSI.results.length > 0){
      const t = testSI.results[0];
      console.log(`[Poly SI] working ✓ (AAPL short_interest: ${fmtN(t.short_interest)}, settlement: ${t.settlement_date})`);
    } else {
      console.log(`[Poly SI] unexpected response: ${JSON.stringify(testSI)?.slice(0,200)}`);
    }
  } catch(e) { console.error('[Poly SI] connectivity test failed:', e.message); }

  loadPermanentWatchlist();
  await refreshEtfList();
  await refreshRegSHO();
  await refreshGappers();
  await recoverDayGappers(); // restore today's gappers that fell off topGappers
  // If bot starts during AH, capture close prices immediately
  const _startEt = getET();
  if(_startEt.etMin >= 960 && _startEt.etMin < 1200){
    console.log('[Startup] AH detected — running transition sync immediately');
    await syncHighsAtTransition();
  }
  connectPriceWS();
  connectDiscord();
  // if(BZ_KEY) connectBZ();
  await registerCommands();

  setInterval(async()=>{
    // Reload watchlist.txt every 5 minutes to pick up edits without redeploying
    if(Date.now()-lastWatchlistRead>5*60*1000){loadPermanentWatchlist();lastWatchlistRead=Date.now();}
    await refreshEtfList();
    await refreshGappers();
    const newT=[...new Set([...topGappers.map(g=>g.ticker),...dayWatchlist.keys(),...permanentWatch])].filter(t=>!subscribedTickers.has(t));
    if(newT.length) subscribeNewTickers(newT);
    await pollNews();
    await syncHighsAtTransition(); // capture 4PM close prices within 20s
  },20*1000);

  // Halt polling runs on its OWN 5s interval, decoupled from the main loop.
  // NASDAQ RSS is a small XML document; 5s polling is conservative and gives
  // sub-10s detection latency on halt events. Cache-Control headers prevent
  // any CDN caching at the edge.
  setInterval(async()=>{
    try { await pollHalts(); } catch(e){ console.error('[Halts] loop error:', e.message); }
  }, 5*1000);

  setInterval(async()=>{
    const {hh,m}=getET();
    if(hh===0&&m<1){state.dailyCounts.clear();state.tickers.clear();state.sentFilings.clear();dayWatchlist.clear();closePrice.clear();
      // Prune recentRunners older than 5 days
      const fiveDaysAgo=Date.now()-5*24*60*60*1000;
      for(const [t,ts] of recentRunners) if(ts<fiveDaysAgo) recentRunners.delete(t);
      console.log(`[Daily] recentRunners: ${recentRunners.size} tickers kept`);console.log('[Daily] Reset');}
    await checkMorningSnapshot();
    await checkFilings();
    await syncHighsAtTransition();
    await refreshRegSHO(); // self-rate-limits to 23h, safe to call every minute
  },60*1000);

  console.log('🤖 AziziBot v8 running.');
}

main().catch(err=>{console.error('Fatal:',err);process.exit(1);});
