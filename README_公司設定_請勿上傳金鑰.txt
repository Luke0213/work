SPC 工程管理｜公司電腦安全設定

1. 解壓縮後，在專案根目錄自行建立 .env.local。
2. 只可填入自己的 Supabase 專案資料，不要把 .env.local 放入 ZIP、GitHub、LINE 或電子郵件。
3. .env.local 格式：

NEXT_PUBLIC_SUPABASE_URL=你的 Supabase URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=你的 Publishable Key
SUPABASE_SERVICE_ROLE_KEY=你的新 Secret Key

4. SUPABASE_SERVICE_ROLE_KEY 只能放在受保護的伺服器環境或自己控制的開發電腦，絕不可放進前端原始碼或公開儲存庫。
5. 安裝與啟動：

pnpm install
pnpm dev

6. 正式網站的 Secret Key 必須另外設定在網站平台的受保護 Secrets 中，不能寫進 GitHub。

安全帶回公司方式（由安全到方便）：

1. 首選：使用有 BitLocker／裝置加密的 USB 隨身碟，僅複製「安全版 ZIP」。
2. 次選：上傳公司核准的 OneDrive／Google Drive 私人資料夾；不要設公開分享連結。
3. 不建議：LINE、一般電子郵件附件、公開 GitHub 或任何公開雲端連結。
4. Secret Key 不跟 ZIP 一起傳。到公司後登入 Supabase Dashboard 重新複製，直接貼到公司電腦的 .env.local。
5. .env.local 建立後確認它仍被 .gitignore 忽略，再執行 pnpm install 與 pnpm dev。
6. 若公司電腦只負責修改畫面、不測試帳號管理，可以暫時只放 URL 與 Publishable Key，不放 Secret Key。
