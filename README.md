# 🌍 CANON (prototype)

> マイクラ風のサンドボックスだが、**物理・アイテムの法則がプログラムで決まっていない**。
> プレイヤーが何かを組み合わせると、その結果を **AI が裁定**し、
> **世界で初めての組み合わせはその瞬間に全プレイヤー共通の「正史」として永久に確定**する。
> 既知の組み合わせは AI を呼ばず DB から再現されるため、安価かつ一貫している。

`voxel-craft` から派生した CANON コンセプトの最初の動くプロトタイプ。

## コアループ

1. 平原のブロック（地面・石・木）を壊して集める（ツールがあれば対象を高速採掘）
2. **E** でクラフト。素材2つを AI に渡し、結果を生成
3. **世界初の組み合わせ** → AI 生成 → 正史に確定・発見者クレジット付与・🌍 演出
4. 既に誰かが発見済み → DB から同じ結果を再現（LLM 不使用＝無料・一貫）
5. 右上の「世界の発見」フィードに、全プレイヤーの最新発見が流れる

## 差別化（CANON の堀）

- **一貫性エンジン**: 生成時に既存の正史（直近の語彙）を文脈注入し、世界観の矛盾を防ぐ（`canonContext()`）
- **累積する共有正史**: 発見が増えるほど世界が深くなる独自データ資産
- **発見者クレジット**: 「世界で初めて◯◯を生んだのは誰か」が記録される

## ローカル起動

```bash
cd products/voxel-craft
npm install
aws sso login            # ZenMedia アカウントの SSO（鍵取得に使用）
./scripts/start-local.sh # Secrets Manager から GEMINI_API_KEY を取得して起動
# → http://localhost:3000
```

鍵を自前で持っている場合は `GEMINI_API_KEY=... npm start` でも可。

## 公開耐性（コスト・不正対策）

公開時に従量課金（特に画像生成）が暴走しないためのガードを内蔵：

| 環境変数 | 既定 | 役割 |
|---|---|---|
| `MAX_NEW_PER_DAY` | 400 | 1日あたりの「世界初の生成」上限（コスト遮断器） |
| `RATE_PER_MIN` | 20 | IP あたりの新規発見/分（連打対策） |
| `ENABLE_IMAGES` | on | `0` で画像生成を無効化（コスト最小化） |
| `DB_PATH` | ./craft-cache.db | 正史 DB の保存先（本番は永続ボリューム） |
| `PORT` | 3000 | 待受ポート |

上限到達後も「既知の組み合わせ」は無料で遊べる。

## デプロイ

Express + `node:sqlite`（ネイティブ依存なし）。**永続ディスク**に DB を置ける
コンテナ環境向け。

```bash
docker build -t canon .
docker run -p 8080:8080 \
  -e GEMINI_API_KEY=*** \
  -v canon-data:/data \
  canon
```

- DB は単一ファイル SQLite のため、**単一インスタンス + 永続ボリューム**が前提
  （Fly.io / Render / ECS+EFS / Lightsail 等）。水平スケール時は外部 DB へ要移行。
- `GEMINI_API_KEY` はホストのシークレットとして注入（リポ・イメージに焼かない）。

## アーキテクチャ

| 要素 | 実装 |
|------|------|
| 3D・破壊・採掘・設置 | Three.js（`public/game.js`） |
| 裁定 API | `POST /api/craft {a,b,handle}` → `{result, source, discovery}` |
| 発見フィード | `GET /api/feed` → 直近15件（画像なしで軽量） |
| LLM（属性裁定） | Gemini `gemini-3.5-flash`（JSON 出力） |
| LLM（アイコン生成） | Gemini `gemini-2.5-flash-image`（初回のみ、data URL） |
| 共有正史 DB | SQLite `combos(combo_key, result_json, created_at, discoverer)` |
