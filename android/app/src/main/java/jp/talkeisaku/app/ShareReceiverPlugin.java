package jp.talkeisaku.app;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

// ほかのアプリの「共有」で送られたファイルやテキストを受け取る（LINE の「トーク履歴を送信」など）
// 受け取った内容はこの端末の中だけで扱い、どこにも送らない
@CapacitorPlugin(name = "ShareReceiver")
public class ShareReceiverPlugin extends Plugin {

    private static final int MAX_BYTES = 30 * 1024 * 1024;
    private Uri pendingUri;
    private String pendingText;

    // アプリが共有から起動したとき
    @Override
    public void load() {
        remember(getActivity().getIntent());
    }

    // アプリを開いている途中で共有されたとき。アプリ側には「届いた」ことだけを知らせ、中身は takePending で渡す
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (remember(intent)) notifyListeners("shared", new JSObject());
    }

    // 共有の intent なら、中身の場所を覚えておく。同じ共有を二度読み込まないよう、intent の action は消す
    private synchronized boolean remember(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return false;
        Uri uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (uri == null && text == null) return false;
        pendingUri = uri;
        pendingText = uri == null ? text.toString() : null;
        intent.setAction(null);
        return true;
    }

    // 受け取った中身を返して忘れる。何もなければ空のオブジェクト
    @PluginMethod
    public void takePending(PluginCall call) {
        Uri uri;
        String text;
        synchronized (this) {
            uri = pendingUri;
            text = pendingText;
            pendingUri = null;
            pendingText = null;
        }
        JSObject ret = new JSObject();
        if (uri == null) {
            if (text != null) ret.put("text", text);
            call.resolve(ret);
            return;
        }
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) {
                ret.put("error", "unreadable");
                call.resolve(ret);
                return;
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > MAX_BYTES) {
                    ret.put("error", "too_large");
                    call.resolve(ret);
                    return;
                }
                out.write(buf, 0, n);
            }
            ret.put("text", new String(out.toByteArray(), StandardCharsets.UTF_8));
            ret.put("name", displayName(uri));
        } catch (Exception e) {
            ret.put("error", "unreadable");
        }
        call.resolve(ret);
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
            // 名前が取れなくても読み込みには困らない
        }
        return "";
    }
}
