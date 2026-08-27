SPC 工程管理系統｜Supabase 完整版
===================================

這個資料夾已包含：
1. 完整前端原始碼
2. Supabase JavaScript 連線程式
3. Supabase PostgreSQL migration
4. Row Level Security（RLS）設定
5. 本機環境變數
6. 舊 localStorage 資料首次自動搬移功能
7. Windows 一鍵安裝／啟動腳本

目前 Supabase 狀態
-----------------
你已經成功執行 SQL migration。資料庫在 Supabase 雲端，家裡電腦關機不會讓
資料庫停止，也不會刪除已同步資料。

明天到公司的步驟
----------------
1. 把整個 ZIP 帶到公司電腦。
2. 解壓縮 ZIP（不要直接在壓縮檔內開啟）。
3. 安裝 Node.js LTS：https://nodejs.org/
4. 雙擊「公司電腦_安裝與啟動.cmd」。
5. 第一次會安裝套件，完成後依終端機顯示開啟 localhost 網址。

手動啟動方式
------------
在此資料夾開啟終端機後執行：

  npm install -g pnpm
  pnpm install
  pnpm dev

重要檔案
--------
- app/page.tsx：主要網頁與 Supabase 自動同步邏輯
- lib/supabase.ts：Supabase client
- supabase/migrations/202608230001_spc_app_state.sql：資料庫與 RLS
- .env.local：目前專案的 URL 與 Publishable key
- SUPABASE_SETUP.md：完整 Supabase 說明

安全說明
--------
目前依需求採「網站免登入」模式，因此 Supabase 後台用 GitHub 登入與前端無關。
Publishable key 不是資料庫密碼；真正權限由 RLS 控制。

免登入網站若部署到公開網址，知道網址的人可能讀寫 main 工作區。正式提供多人
使用前，建議加入 Supabase Auth 或公司帳號限制。

照片說明
--------
目前照片會跟著工程狀態一起同步到 Supabase JSON。少量使用沒有問題；照片大量
增加後，建議下一階段搬到 Supabase Storage，避免單筆資料過大。

部署說明
--------
pnpm dev 只供本機測試。若需要家裡、公司、手機都透過固定網址開啟，仍需部署到
Cloudflare 或 Vercel。部署時必須設定與 .env.local 相同的兩個公開環境變數。
