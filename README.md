# トーク英作（Capacitor + Supabase 版）

自分のLINEのトーク履歴を問題にして、英語で言う練習をするアプリです。1つのコードから、Web版・Androidアプリ・iPhoneアプリを作ります。

## 構成

| 部分 | 使うもの | 中身 |
| --- | --- | --- |
| アプリ本体 | Vite + Capacitor | `src/`。Web版とスマホアプリ版で共通 |
| ログイン | Supabase Auth | メールに届く6桁のコードでログイン |
| 学習記録の同期 | Supabase Database | 端末で暗号化した学習記録だけを保存（`supabase/migrations/`） |
| AIコーチ | Supabase Edge Functions | ログイン・1日の上限を確認して Claude API に中継（`supabase/functions/coach/`） |
| アカウントの削除 | Supabase Edge Functions | ログイン中の本人のアカウントと、サーバー上の記録をすべて消す（`supabase/functions/delete-account/`） |

### データの流れ

- **トーク履歴**：端末の中だけに保存し、サーバーには送りません。
- **学習記録・回答履歴**：端末で暗号化してからサーバーに保存します。鍵は「復元キー」から作り、運営者は保管しません。
- **AIへの依頼**：問題文・回答・前後のやり取り（話し手は Me / Friend に置き換え、名前は送らない）を Edge Function に送ります。Edge Function はそれを保存もログ出力もせずに Claude API に中継します。
- **指示文（プロンプト）**：サーバー側の `supabase/functions/coach/prompts.ts` にあります。アプリを更新しなくても、ここを直してデプロイすれば変えられます。

## 必要なもの

- Node.js 20 以上
- Supabase のアカウント
- Anthropic の APIキー（Claude Console で作成）
- Androidアプリを作る場合：Android Studio
- iPhoneアプリを作る場合：Mac と Xcode、Apple Developer Program

## 1. Supabase の準備

1. Supabase で新しいプロジェクトを作ります。リージョンは「Northeast Asia (Tokyo)」を選びます。
2. 「Authentication」→「Sign In / Providers」で Email を有効にします。
3. 「Authentication」→「Emails」→「SMTP Settings」で、独自のSMTP（メール送信サービス）を設定します。Supabase標準のメール送信のままでは、メールの本文を編集できず、送れる相手（組織のメンバーだけ）と回数も限られるためです。開発中は Resend の無料プランを使います（ホスト `smtp.resend.com`、ポート `465`、ユーザー名 `resend`、パスワードは Resend の API キー、送信元 `onboarding@resend.dev`）。この送信元は Resend に登録したメールアドレスにしか送れないので、公開する前に独自ドメインを Resend で認証し、送信元をそのドメインのアドレスに変えます。
4. 「Authentication」→「Emails」→「Templates」で、「Confirm sign up」と「Magic link or OTP」の2つのメール本文に `{{ .Token }}` を入れます。これで6桁のコードがメールで届くようになります（はじめてログインする人には「Confirm sign up」が届くため、両方に入れます）。
5. このフォルダで次を実行します（`<project-ref>` はプロジェクトのURLの xxxxx 部分）。Claude の Supabase コネクタを使う場合は、データベースの変更と Edge Function のデプロイをコネクタから行えます。

   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-... DAILY_LIMIT=300 REQUIRE_SUBSCRIPTION=false
   npx supabase functions deploy coach
   npx supabase functions deploy delete-account
   ```

6. 無料プランは7日間ほとんど使われないと一時停止します。公開するときは有料プランに切り替えてください。

## 2. アプリを動かす

1. `.env.example` を `.env` にコピーし、Supabase のダッシュボードの「Connect」（または「Settings」→「API Keys」）にある Project URL と Publishable key（`sb_publishable_` で始まる公開用のキー）を書きます。従来の anon key でも動きます。
2. 依存パッケージを入れて、ブラウザで確認します。

   ```bash
   npm install
   npm run dev
   ```

3. `capacitor.config.json` の `appId`（今は `jp.talkeisaku.app`）を、あなたのドメインを逆にした形に変えます。ストアに出したあとは変えられません。`android/` にも同じ値が入っているので、`android/app/build.gradle` の `namespace` と `applicationId`、`android/app/src/main/res/values/strings.xml`、`MainActivity.java` の置き場所とパッケージ名も合わせて直します。

### Android

Android のプロジェクトは `android/` に入っています。音声入力に必要なマイクの権限と、音声認識・読み上げのサービスの指定も、`android/app/src/main/AndroidManifest.xml` に書いてあります。

```bash
npm run android
```

Android Studio が開くので、実機かエミュレーターで実行します。初めて開いたときに Gradle が使う Java（Gradle JVM）を聞かれたら、JDK 21 を選びます。

アプリのアイコンと起動画面のアイコンは、`public/icon-512.png` と `public/icon-maskable-512.png` から作っています。アイコンを変えたら `python3 scripts/make_android_icons.py`（Pillow が必要）で作り直します。

### iPhone（Mac が必要）

```bash
npx cap add ios
```

`ios/App/App/Info.plist` に次の2つを追加します。

- `NSSpeechRecognitionUsageDescription`：英語の回答を音声で入力するために使います。
- `NSMicrophoneUsageDescription`：英語の回答を音声で入力するために使います。

```bash
npm run ios
```

### Web版

`npm run build` で `dist/` ができます。Cloudflare Pages では、ビルドコマンドを `npm run build`、出力先を `dist` にし、環境変数に `VITE_SUPABASE_URL` と `VITE_SUPABASE_ANON_KEY` を設定します。

## 3. 変更したあと

- アプリのコードを変えたら：`npm run android` / `npm run ios`（中で `vite build` と `cap sync` を実行します）
- 指示文を変えたら：`npx supabase functions deploy coach`
- アカウントの削除の処理を変えたら：`npx supabase functions deploy delete-account`
- データベースを変えたら：`supabase/migrations/` に新しいSQLを足して `npx supabase db push`

## まだ入っていないもの

- サブスク課金（RevenueCat）。入れるまでは `REQUIRE_SUBSCRIPTION=false` のまま、ログインした人は誰でも1日 `DAILY_LIMIT` 回まで使えます。
- Google・Appleでのログイン

## テスト

`test/index.test.html` は、Supabase と Capacitor を偽物に置き換えて、ブラウザだけで動かすためのページです。Vite ではなく、ファイルをそのまま配る簡易サーバー（例：このフォルダで `python -m http.server 8080`）で `http://localhost:8080/test/index.test.html` を開くと、ネットにつながずに、ログイン・同期・出題の流れを確かめられます（確認コードは `123456`）。

Android のエミュレーターで本物の Supabase につないで試すときは、`test/sample_line.txt`（テスト用の短いトーク履歴）をエミュレーターの画面にドラッグ＆ドロップすると「Download」に入るので、アプリの「トーク履歴を選ぶ」から読み込めます。
