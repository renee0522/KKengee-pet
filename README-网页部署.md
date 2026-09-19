# 啃叽多人电子宠物：网页版部署说明

这个项目已经是完整的“网页 + 服务器”结构：手机或电脑打开网站网址即可玩，好友和 PK 通过服务器同步。

## 最简单的上线方式：Render

1. 把整个项目上传到 GitHub 仓库。
2. 注册 Render，并选择 **New → Web Service**。
3. 连接这个 GitHub 仓库。
4. Build Command 填：`npm install`
5. Start Command 填：`npm start`
6. 添加环境变量：
   - `ADMIN_KEY`：设置一个你自己的管理员密钥。
7. 部署完成后 Render 会给你一个 `https://xxxx.onrender.com` 的网址。
8. 用手机打开这个网址，就能注册、登录和玩啃叽。

## 注意

当前版本的数据保存在 `data.json`，订单截图保存在 `uploads/`。这适合测试和小规模使用，但不适合作为长期正式生产站点：某些云平台的免费实例文件系统可能在重新部署/重启时丢失数据。

如果以后要长期给很多人使用，建议把账号、好友、PK、啃叽币、订单改成 PostgreSQL/MySQL，并把订单截图放到对象存储。

## 本地测试

Node.js 18+：

```bash
npm install
ADMIN_KEY=your-secret-key npm start
```

浏览器打开 `http://localhost:3000`。
