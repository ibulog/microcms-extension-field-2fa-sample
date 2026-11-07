# microCMS 2要素認証チェック拡張フィールド

microCMSのログインユーザーのメールアドレスを受け取り、2要素認証の設定状況を表示する拡張フィールドです。

- 設定済み：設定済みのメッセージを表示
- 未設定：[設定ドキュメント](https://document.microcms.io/manual/mfa-setting)へ案内
- 取得失敗・該当ユーザーなし：確認できなかった旨を表示

TypeScript / Node.js 24 / [microcms-field-extension-api](https://github.com/microcmsio/microcms-field-extension)を使用しています。メンバー一覧の取得・照合はサーバー側で行い、APIキーや一覧はブラウザへ返しません。表示専用で、コンテンツへの保存は行いません。SAMLは対象外です。

## 起動

```sh
npm ci
cp .env.example .env
# .envを編集
npm run build
npm start
```

`.env`に以下を設定してください。その他の項目は[.env.example](.env.example)を参照してください。

| 環境変数 | 内容 |
| --- | --- |
| `MICROCMS_SERVICE_ID` | 対象サービスのID |
| `MICROCMS_API_KEY` | 「メンバーの取得（一覧・詳細）」のみを許可したAPIキー |
| `APP_ORIGIN` | 本アプリのオリジン。ローカルは`http://localhost:3000`、本番はHTTPS |

## microCMSの設定

1. APIスキーマに「拡張フィールド」を追加し、本アプリのルートURLを指定します。
2. 必須設定をオフにし、コンテンツの新規作成・編集画面で表示を確認します。
3. 2要素認証の設定後は「再確認」を押してください。

URLを直接開いた場合は、microCMSからユーザー情報を受信できないため確認不能と表示されます。

## デプロイ

Node.js 24の実行環境、または[Dockerfile](Dockerfile)を利用してください。

- **デプロイ基盤で、画面・APIの両方に社内／VPNの固定IP許可リストを適用してください。** アプリ自身はIP制限を行いません。標準URLや直接アクセスによる迂回も防いでください。
- HTTPSを使用し、APIキーはサーバーの環境変数で管理してください。`.env`はコミットしません。
- IP制限は個人認証ではありません。許可された回線内では、任意のメールアドレスの登録有無・MFA状態を照会できる前提です。
- キャッシュ・APIの間隔制御は1プロセス単位のため、初期構成は1レプリカを想定しています。

## 開発・検証

```sh
npm run dev           # 変更監視・再ビルド・再起動
npm run check         # 型検査
npm test              # ビルド・単体テスト・HTTP結合テスト
npm run test:browser  # Chromeでiframe連携・画面操作を検証
```

GitHub Actionsでも型検査・ビルド・テストを実行します。テストにmicroCMSのAPIキーは不要です。
