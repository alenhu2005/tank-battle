#!/usr/bin/env bash
# 坦克對戰：一鍵部署到 Google Cloud Run（在 Google Cloud Shell 裡執行：bash deploy.sh）
set -euo pipefail

SERVICE="tank-battle"
REGION="asia-east1"   # 台灣（彰化）機房
cd "$(dirname "$0")"

say()  { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }

command -v gcloud >/dev/null || fail "找不到 gcloud，請在 Google Cloud Shell 裡執行這個腳本"

ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
[ -n "$ACCOUNT" ] || fail "還沒登入 Google，請先執行：gcloud auth login"

# 1. 專案：用參數指定的、目前選的，或幫你建立一個新的
say "1/5 選擇 Google Cloud 專案"
PROJECT="${1:-$(gcloud config get-value project 2>/dev/null || true)}"
if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
  PROJECT="tank-battle-$(date +%m%d)-$((RANDOM % 9000 + 1000))"
  echo "建立新專案：$PROJECT"
  gcloud projects create "$PROJECT" --name="tank-battle" --quiet
fi
gcloud config set project "$PROJECT" --quiet >/dev/null
echo "使用專案：$PROJECT"

# 2. 帳單帳戶（AI Pro 的 Cloud 額度掛在帳單帳戶上）
say "2/5 檢查帳單帳戶"
BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || true)"
if [ "$BILLING" != "True" ]; then
  mapfile -t ACCOUNTS < <(gcloud billing accounts list --filter='open=true' --format='value(name.basename())')
  if [ "${#ACCOUNTS[@]}" -eq 0 ]; then
    fail "你的 Google 帳號還沒有帳單帳戶。
  請先打開 https://console.cloud.google.com/billing 建立帳單帳戶
  （或依照 Google AI Pro 的開發者福利領取 Cloud 額度），完成後再執行一次：bash deploy.sh"
  fi
  BILL_ID="${ACCOUNTS[0]}"
  if [ "${#ACCOUNTS[@]}" -gt 1 ]; then
    gcloud billing accounts list --filter='open=true'
    read -rp "你有多個帳單帳戶，請輸入要用的 ACCOUNT_ID（直接按 Enter 使用 $BILL_ID）：" PICK
    [ -n "${PICK:-}" ] && BILL_ID="$PICK"
  fi
  gcloud billing projects link "$PROJECT" --billing-account="$BILL_ID" --quiet
fi
echo "帳單已啟用"

# 3. 啟用需要的服務
say "3/5 啟用 Cloud Run 相關服務（第一次大約 1～2 分鐘）"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com compute.googleapis.com --quiet

# 4. 新專案的建置權限（讓 Cloud Build 能把程式打包成容器）
say "4/5 設定建置權限"
PNUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
for SA in "${PNUM}-compute@developer.gserviceaccount.com" "${PNUM}@cloudbuild.gserviceaccount.com"; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" \
    --role="roles/run.builder" --condition=None --quiet >/dev/null 2>&1 || true
done

# 存放建置結果的 Artifact Registry。新專案剛啟用服務時，權限要等一兩分鐘才會生效，所以失敗會自動重試
AR_REPO="cloud-run-source-deploy"
for i in 1 2 3 4 5 6 7 8; do
  if gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" >/dev/null 2>&1; then break; fi
  if gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location="$REGION" \
       --description="Cloud Run source deployments" --quiet >/dev/null 2>&1; then break; fi
  echo "Google 的權限還在生效中，20 秒後重試（$i/8）…"
  sleep 20
done

# 5. 部署
say "5/5 建置並部署（大約 3～5 分鐘）"
deploy() {
  gcloud run deploy "$SERVICE" \
    --source . \
    --region "$REGION" \
    --allow-unauthenticated \
    --max-instances 1 \
    --min-instances 0 \
    --memory 512Mi --cpu 1 \
    --timeout 3600 \
    --session-affinity \
    --quiet
}
for i in 1 2 3; do
  if deploy; then break; fi
  [ "$i" -eq 3 ] && fail "部署失敗。請把上面的錯誤訊息貼給 Claude，或過幾分鐘再執行一次 bash deploy.sh"
  echo "部署失敗，可能是新專案的權限還沒生效，60 秒後自動重試（$i/3）…"
  sleep 60
done

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
printf '\n\033[1;32m✔ 完成！遊戲網址：%s\033[0m\n' "$URL"
echo "把這個網址傳給朋友，用手機打開就能玩。之後要更新版本，再執行一次 bash deploy.sh 即可。"
