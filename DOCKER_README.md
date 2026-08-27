# Docker 打包說明

這份 Docker 設定只打包 SPC 工程管理網站本身，不包含資料庫。
資料仍然連到原本的 Supabase。

## 第一次使用

1. 複製環境設定：

```bash
cp .env.docker.example .env.docker
```

2. 打開 `.env.docker`，填入 `SUPABASE_SERVICE_ROLE_KEY`。

3. 建立並啟動：

```bash
docker compose up --build -d
```

4. 開啟：

```text
http://localhost:3000
```

## 停止

```bash
docker compose down
```

## 匯出 Docker 映像檔

```bash
docker save spc-project-management:latest -o spc-project-management.tar
```

帶到另一台電腦後：

```bash
docker load -i spc-project-management.tar
docker compose up -d
```
