
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-this-admin-key";
const DB_FILE = path.join(__dirname, "data.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");
if(!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, {recursive:true});

function loadDB(){
  if(!fs.existsSync(DB_FILE)){
    const d={users:{},friendRequests:[],battles:{},orders:{},logs:[],settings:{coinRate:10}};
    fs.writeFileSync(DB_FILE,JSON.stringify(d,null,2)); return d;
  }
  return JSON.parse(fs.readFileSync(DB_FILE,"utf8"));
}
let db=loadDB();
for(const u of Object.values(db.users)){
  if(!Array.isArray(u.friends))u.friends=[];
  if(u.food==null)u.food=5;
  if(u.water==null)u.water=5;
  if(u.dirty==null)u.dirty=false;
  if(u.traveling==null)u.traveling=false;
  if(u.travelEndAt==null)u.travelEndAt=null;
  if(u.moodUpdatedAt==null)u.moodUpdatedAt=Date.now();
}
save();
const sessions=new Map();
const adminSessions=new Set();

function save(){fs.writeFileSync(DB_FILE,JSON.stringify(db,null,2))}
function applyMoodDecay(u){
  if(!u)return;
  if(!u.moodUpdatedAt)u.moodUpdatedAt=Date.now();
  const elapsed=Math.floor((Date.now()-u.moodUpdatedAt)/60000);
  if(elapsed>0){u.happy=Math.max(0,(u.happy==null?80:u.happy)-elapsed);u.moodUpdatedAt+=elapsed*60000;save()}
}
function id(){return crypto.randomBytes(12).toString("hex")}
function hash(s){return crypto.createHash("sha256").update(s).digest("hex")}
function send(res,code,obj){res.writeHead(code,{"Content-Type":"application/json; charset=utf-8"});res.end(JSON.stringify(obj))}
function readBody(req){return new Promise((resolve,reject)=>{let b="";req.on("data",c=>{b+=c;if(b.length>12e6) req.destroy()});req.on("end",()=>{try{resolve(JSON.parse(b||"{}"))}catch(e){reject(e)}})})}
function safeUser(u){if(u)applyMoodDecay(u);return u?{id:u.id,username:u.username,coins:u.coins,hunger:u.hunger,happy:u.happy,level:u.level,wins:u.wins,losses:u.losses,friends:u.friends,food:u.food||0,water:u.water||0,dirty:!!u.dirty,traveling:!!u.traveling,travelEndAt:u.travelEndAt||null}:null}
function userByName(n){return Object.values(db.users).find(u=>u.username.toLowerCase()===String(n).toLowerCase())}
function auth(req){const t=(req.headers.authorization||"").replace("Bearer ","");return db.users[sessions.get(t)]||null}
function isAdmin(req){const t=(req.headers["x-admin-token"]||"");return adminSessions.has(t)}

const server=http.createServer(async(req,res)=>{
  try{
    if(req.url==="/health" || req.url==="/api/health") return send(res,200,{ok:true,service:"kenji-pet"});

    if(req.url.startsWith("/api/")){
      const u=new URL(req.url,`http://${req.headers.host}`), route=u.pathname, me=auth(req);

      if(req.method==="POST"&&route==="/api/register"){
        const b=await readBody(req); if(!b.username||!b.password)return send(res,400,{error:"请填写用户名和密码"});
        if(userByName(b.username))return send(res,409,{error:"用户名已存在"});
        const x={id:id(),username:String(b.username).slice(0,20),passwordHash:hash(String(b.password)),coins:0,hunger:70,happy:80,level:1,wins:0,losses:0,friends:[],food:5,water:5,dirty:false,traveling:false,travelEndAt:null,moodUpdatedAt:Date.now()};
        db.users[x.id]=x;save();return send(res,200,{user:safeUser(x)});
      }
      if(req.method==="POST"&&route==="/api/login"){
        const b=await readBody(req),x=userByName(b.username||"");
        if(!x||x.passwordHash!==hash(String(b.password||"")))return send(res,401,{error:"用户名或密码错误"});
        const t=id();sessions.set(t,x.id);return send(res,200,{token:t,user:safeUser(x)});
      }
      if(route==="/api/me"){if(!me)return send(res,401,{error:"请先登录"});if(me.traveling&&me.travelEndAt&&Date.now()>=me.travelEndAt)finishTravel(me.id);return send(res,200,{user:safeUser(me)})}

      // Travel / care system
      if(route==="/api/supplies/buy"&&req.method==="POST"){
        if(!me)return send(res,401,{error:"请先登录"});
        if(me.traveling)return send(res,400,{error:"啃叽正在旅行中"});
        const b=await readBody(req),type=b.type,amount=Math.floor(Number(b.amount));
        if(!["food","water"].includes(type)||!amount||amount<1||amount>100)return send(res,400,{error:"购买数量不正确"});
        const cost=amount;
        if(me.coins<cost)return send(res,400,{error:"啃叽币不足"});
        me.coins-=cost;me[type]=(me[type]||0)+amount;save();return send(res,200,{user:safeUser(me),cost});
      }
      if(route==="/api/travel/start"&&req.method==="POST"){
        if(!me)return send(res,401,{error:"请先登录"});
        if(me.traveling)return send(res,400,{error:"啃叽已经在旅行了"});
        if(me.dirty)return send(res,400,{error:"啃叽还脏兮兮的，先给它洗澡吧"});
        if((me.happy||0)>60)return send(res,400,{error:"啃叽现在心情还不错，等它没那么开心时再带它出门吧"});
        const needFood=3,needWater=3;
        if((me.food||0)<needFood)return send(res,400,{error:`食物不够，旅行至少需要 ${needFood} 份食物`});
        if((me.water||0)<needWater)return send(res,400,{error:`水不够，旅行至少需要 ${needWater} 份水`});
        me.food-=needFood;me.water-=needWater;me.traveling=true;me.travelEndAt=Date.now()+60000;me.happy=Math.min(100,(me.happy||0)+20);save();
        setTimeout(()=>finishTravel(me.id),60100);
        return send(res,200,{user:safeUser(me)});
      }
      if(route==="/api/travel/bathe"&&req.method==="POST"){
        if(!me)return send(res,401,{error:"请先登录"});
        if(me.traveling)return send(res,400,{error:"啃叽还在旅行中"});
        if(!me.dirty)return send(res,400,{error:"啃叽现在很干净，不需要洗澡"});
        me.dirty=false;me.happy=Math.min(100,(me.happy||0)+8);save();return send(res,200,{user:safeUser(me)});
      }

      // Friend system
      if(route==="/api/friends"&&req.method==="GET"){
        if(!me)return send(res,401,{error:"请先登录"});
        return send(res,200,{friends:me.friends.map(x=>safeUser(db.users[x])).filter(Boolean)});
      }
      if(route==="/api/friends/request"&&req.method==="POST"){
        if(!me)return send(res,401,{error:"请先登录"});const b=await readBody(req),t=userByName(b.username||"");
        if(!t||t.id===me.id)return send(res,400,{error:"用户不存在或不能添加自己"});
        if(me.friends.includes(t.id))return send(res,400,{error:"已经是好友"});
        db.friendRequests.push({id:id(),from:me.id,to:t.id,status:"pending"});save();return send(res,200,{ok:true});
      }
      if(route==="/api/friends/pending"&&req.method==="GET"){
        if(!me)return send(res,401,{error:"请先登录"});
        return send(res,200,{requests:db.friendRequests.filter(x=>x.to===me.id&&x.status==="pending").map(x=>({id:x.id,from:safeUser(db.users[x.from])}))});
      }
      if(route==="/api/friends/accept"&&req.method==="POST"){
        if(!me)return send(res,401,{error:"请先登录"});const b=await readBody(req),r=db.friendRequests.find(x=>x.id===b.id&&x.to===me.id&&x.status==="pending");
        if(!r)return send(res,404,{error:"申请不存在"});r.status="accepted";if(!me.friends.includes(r.from))me.friends.push(r.from);if(!db.users[r.from].friends.includes(me.id))db.users[r.from].friends.push(me.id);save();return send(res,200,{ok:true});
      }

      // Player submits an order with screenshot data URL. Admin later reviews it.
      if(route==="/api/orders"&&req.method==="POST"){
        if(!me)return send(res,401,{error:"请先登录"});
        const b=await readBody(req),money=Number(b.money);
        if(!money||money<=0||money>100000)return send(res,400,{error:"充值金额不正确"});
        let fileName=null;
        if(typeof b.screenshot==="string"&&b.screenshot.startsWith("data:image/")){
          const m=b.screenshot.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
          if(!m)return send(res,400,{error:"图片格式不支持"});
          fileName=id()+"."+({jpeg:"jpg",jpg:"jpg",png:"png",webp:"webp"}[m[1]]||"png");
          fs.writeFileSync(path.join(UPLOAD_DIR,fileName),Buffer.from(m[2],"base64"));
        }else return send(res,400,{error:"请上传订单截图"});
        const order={id:id(),userId:me.id,money,coinRate:db.settings.coinRate,coinAmount:Math.floor(money*db.settings.coinRate),screenshot:fileName,status:"pending",createdAt:new Date().toISOString(),reviewedAt:null};
        db.orders[order.id]=order;save();return send(res,200,{order:{id:order.id,money:order.money,coinAmount:order.coinAmount,status:order.status}});
      }

      // Admin
      if(route==="/api/admin/login"&&req.method==="POST"){
        const b=await readBody(req);if(b.key!==ADMIN_KEY)return send(res,403,{error:"管理员密钥错误"});
        const t=id();adminSessions.add(t);return send(res,200,{token:t});
      }
      if(route==="/api/admin/orders"&&req.method==="GET"){
        if(!isAdmin(req))return send(res,403,{error:"需要管理员权限"});
        const list=Object.values(db.orders).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(o=>({...o,username:db.users[o.userId]?.username||"未知"}));
        return send(res,200,{orders:list,coinRate:db.settings.coinRate});
      }
      if(route==="/api/admin/rate"&&req.method==="POST"){
        if(!isAdmin(req))return send(res,403,{error:"需要管理员权限"});const b=await readBody(req),r=Number(b.rate);
        if(!r||r<=0||r>10000)return send(res,400,{error:"兑换比例不正确"});db.settings.coinRate=r;save();return send(res,200,{rate:r});
      }
      if(route==="/api/admin/order/review"&&req.method==="POST"){
        if(!isAdmin(req))return send(res,403,{error:"需要管理员权限"});
        const b=await readBody(req),o=db.orders[b.orderId];
        if(!o)return send(res,404,{error:"订单不存在"});
        if(o.status!=="pending")return send(res,400,{error:"订单已经处理"});
        if(b.action==="approve"){
          const u=db.users[o.userId];u.coins+=o.coinAmount;o.status="approved";o.reviewedAt=new Date().toISOString();
          db.logs.push({time:o.reviewedAt,action:"order_approved",orderId:o.id,username:u.username,coinAmount:o.coinAmount});
        }else{o.status="rejected";o.reviewedAt=new Date().toISOString()}
        save();return send(res,200,{ok:true});
      }
      if(route.startsWith("/api/order/")&&req.method==="GET"){
        const oid=route.split("/").pop(),o=db.orders[oid];
        if(!o)return send(res,404,{error:"订单不存在"});
        if(!me||o.userId!==me.id)return send(res,403,{error:"无权查看"});
        return send(res,200,{order:{id:o.id,money:o.money,coinAmount:o.coinAmount,status:o.status,createdAt:o.createdAt}});
      }

      // Battle: 30-second eat-more PK.
      if(route==="/api/battle/challenge"&&req.method==="POST"){
        if(!me)return send(res,401,{error:"请先登录"});const b=await readBody(req),t=db.users[b.targetId];
        if(!t||!me.friends.includes(t.id))return send(res,400,{error:"只能向好友发起 PK"});
        const battle={id:id(),a:me.id,b:t.id,status:"pending",createdAt:Date.now(),startAt:null,endAt:null,aScore:0,bScore:0};
        db.battles[battle.id]=battle;save();broadcast("battle_challenge",{battleId:battle.id,from:me.username});
        return send(res,200,{battle});
      }
      if(route==="/api/battle/accept"&&req.method==="POST"){
        if(!me)return send(res,401,{error:"请先登录"});const b=await readBody(req),bt=db.battles[b.id];
        if(!bt||bt.b!==me.id||bt.status!=="pending")return send(res,404,{error:"PK不存在"});
        bt.status="active";bt.startAt=Date.now();bt.endAt=bt.startAt+30000;save();broadcast("battle_start",{battleId:bt.id,startAt:bt.startAt,endAt:bt.endAt});
        setTimeout(()=>finishBattle(bt.id),30050);return send(res,200,{battle:bt});
      }
      if(route==="/api/battle/eat"&&req.method==="POST"){
        if(!me)return send(res,401,{error:"请先登录"});const b=await readBody(req),bt=db.battles[b.id];
        if(!bt||bt.status!=="active")return send(res,400,{error:"PK尚未开始或已经结束"});
        if(Date.now()>bt.endAt){finishBattle(bt.id);return send(res,400,{error:"PK已结束"})}
        if(bt.a!==me.id&&bt.b!==me.id)return send(res,403,{error:"无权参加"});
        if(bt.a===me.id)bt.aScore++;else bt.bScore++;save();broadcast("battle_score",{battleId:bt.id,aScore:bt.aScore,bScore:bt.bScore});
        return send(res,200,{aScore:bt.aScore,bScore:bt.bScore,remaining:Math.max(0,bt.endAt-Date.now())});
      }

      return send(res,404,{error:"API not found"});
    }

    if(req.url.startsWith("/uploads/")){
      const name=path.basename(req.url.split("?")[0]), fp=path.join(UPLOAD_DIR,name);
      if(fs.existsSync(fp)&&fs.statSync(fp).isFile()){res.writeHead(200,{"Content-Type":"image/jpeg"});fs.createReadStream(fp).pipe(res);return}
      res.writeHead(404);res.end("Not found");return;
    }
    let f=req.url==="/" ? "/index.html" : req.url;
    const fp=path.join(__dirname,"public",path.normalize(f).replace(/^(\.\.[\/\\])+/, ""));
    if(fp.startsWith(path.join(__dirname,"public"))&&fs.existsSync(fp)&&fs.statSync(fp).isFile()){
      const ext=path.extname(fp),types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".jpg":"image/jpeg",".png":"image/png"};
      res.writeHead(200,{"Content-Type":types[ext]||"application/octet-stream"});fs.createReadStream(fp).pipe(res);return;
    }
    res.writeHead(404);res.end("Not found");
  }catch(e){console.error(e);send(res,500,{error:"服务器错误"})}
});

function finishTravel(uid){
  const u=db.users[uid];if(!u||!u.traveling)return;
  u.traveling=false;u.travelEndAt=null;u.dirty=true;u.hunger=Math.max(0,(u.hunger||0)-15);u.happy=Math.min(100,(u.happy||0)+10);save();
  broadcast("travel_finish",{userId:u.id,username:u.username});
}

function finishBattle(bid){
  const b=db.battles[bid];if(!b||b.status!=="active")return;
  b.status="finished";b.endAt=b.endAt||Date.now();
  const A=db.users[b.a],B=db.users[b.b];
  if(b.aScore>b.bScore){A.wins++;B.losses++}
  else if(b.bScore>b.aScore){B.wins++;A.losses++}
  save();broadcast("battle_finish",{battleId:b.id,aScore:b.aScore,bScore:b.bScore,winner:b.aScore===b.bScore?"draw":(b.aScore>b.bScore?A.username:B.username)});
}
const wss=new WebSocket.Server({server});
function broadcast(type,payload){const msg=JSON.stringify({type,payload});wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN)c.send(msg)})}
server.listen(PORT,()=>console.log(`啃叽服务器: http://localhost:${PORT}`));
