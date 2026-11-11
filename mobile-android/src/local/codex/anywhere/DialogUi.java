package local.codex.anywhere;

import android.app.Activity;
import android.app.Dialog;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Build;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Shared native popup surfaces; owns presentation only, never requests or credentials. */
final class DialogUi {
    static final int TEXT = 0xffe4ebf4;
    static final int MUTED = 0xffaebbd1;
    static final int ACCENT = 0xffc8b2ea;
    static final int BORDER = 0xff39495f;
    private final Activity activity;

    DialogUi(Activity activity) {
        this.activity = activity;
    }

    Sheet create(String eyebrow, String title, String description) {
        return new Sheet(eyebrow, title, description);
    }

    int dp(float value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    TextView label(String value) {
        TextView label = text(value, 12, MUTED);
        label.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2);
        layout.bottomMargin = dp(8);
        label.setLayoutParams(layout);
        return label;
    }

    EditText field(String hint, String value, boolean multi) {
        EditText input = new EditText(activity);
        input.setTextColor(TEXT);
        input.setHintTextColor(0xff8596ad);
        input.setTextSize(15);
        input.setHighlightColor(0x55c8b2ea);
        input.setPadding(dp(14), dp(13), dp(14), dp(13));
        input.setMinHeight(dp(52));
        input.setSingleLine(!multi);
        input.setGravity(multi ? Gravity.TOP | Gravity.START : Gravity.CENTER_VERTICAL | Gravity.START);
        input.setInputType(InputType.TYPE_CLASS_TEXT | (multi
                ? InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                : InputType.TYPE_TEXT_VARIATION_URI));
        if (multi) {
            input.setMinLines(2);
            input.setMaxLines(4);
        }
        input.setImeOptions(EditorInfo.IME_ACTION_DONE | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
        StateListDrawable background = new StateListDrawable();
        background.addState(new int[]{android.R.attr.state_focused}, rounded(0xff1b2a40, ACCENT, 14));
        background.addState(new int[]{}, rounded(0xff111e30, BORDER, 14));
        input.setBackground(background);
        if (Build.VERSION.SDK_INT >= 29) {
            GradientDrawable cursor = rounded(ACCENT, Color.TRANSPARENT, 1);
            cursor.setSize(dp(2), dp(24));
            input.setTextCursorDrawable(cursor);
        }
        input.setHint(hint == null ? "" : hint);
        input.setText(value == null ? "" : value);
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2);
        layout.bottomMargin = dp(16);
        input.setLayoutParams(layout);
        return input;
    }

    View actionCard(String title, String subtitle, boolean selected, Runnable action) {
        LinearLayout card = new LinearLayout(activity);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setPadding(dp(16), dp(15), dp(16), dp(15));
        card.setMinimumHeight(dp(76));
        card.setSelected(selected);
        card.setBackground(ripple(rounded(selected ? 0xff302d45 : 0xff1b2a3f,
                selected ? ACCENT : BORDER, 17), 17));
        LinearLayout.LayoutParams cardLayout = new LinearLayout.LayoutParams(-1, -2);
        cardLayout.bottomMargin = dp(10);
        card.setLayoutParams(cardLayout);

        LinearLayout copy = new LinearLayout(activity);
        copy.setOrientation(LinearLayout.VERTICAL);
        TextView heading = text(title, 15, TEXT);
        heading.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        heading.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        copy.addView(heading, new LinearLayout.LayoutParams(-1, -2));
        if (subtitle != null && !subtitle.isEmpty()) {
            TextView detail = text(subtitle, 12, selected ? 0xffc7bdd8 : MUTED);
            detail.setLineSpacing(dp(3), 1f);
            detail.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            LinearLayout.LayoutParams detailLayout = new LinearLayout.LayoutParams(-1, -2);
            detailLayout.topMargin = dp(5);
            copy.addView(detail, detailLayout);
        }
        card.addView(copy, new LinearLayout.LayoutParams(0, -2, 1f));
        TextView check = text(selected ? "✓" : "", 14, 0xff241b36);
        check.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        check.setGravity(Gravity.CENTER);
        GradientDrawable circle = rounded(selected ? ACCENT : Color.TRANSPARENT,
                selected ? ACCENT : 0xff617189, 100);
        check.setBackground(circle);
        check.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams checkLayout = new LinearLayout.LayoutParams(dp(23), dp(23));
        checkLayout.leftMargin = dp(14);
        card.addView(check, checkLayout);

        card.setContentDescription(title + (subtitle == null || subtitle.isEmpty() ? "" : "，" + subtitle));
        card.setFocusable(true);
        card.setOnClickListener(view -> {
            if (action != null) action.run();
        });
        card.setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info);
                info.setClassName("android.widget.RadioButton");
                info.setCheckable(true);
                info.setChecked(selected);
            }
        });
        return card;
    }

    View actionLink(String title, String subtitle, Runnable action) {
        LinearLayout card = (LinearLayout) actionCard(title, subtitle, false, action);
        TextView trailing = (TextView) card.getChildAt(1);
        trailing.setText("›");
        trailing.setTextSize(25);
        trailing.setTextColor(ACCENT);
        trailing.setBackground(null);
        card.setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info);
                info.setClassName("android.widget.Button");
                info.setCheckable(false);
            }
        });
        return card;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(activity);
        view.setText(value == null ? "" : value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setIncludeFontPadding(false);
        return view;
    }

    private GradientDrawable rounded(int fill, int stroke, int radius) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(fill);
        background.setCornerRadius(dp(radius));
        if (stroke != Color.TRANSPARENT) background.setStroke(dp(1), stroke);
        return background;
    }

    private Drawable ripple(Drawable content, int radius) {
        return new RippleDrawable(ColorStateList.valueOf(0x20c8b2ea), content,
                rounded(Color.WHITE, Color.TRANSPARENT, radius));
    }

    private Button footerButton(boolean primary) {
        Button button = new Button(activity);
        button.setAllCaps(false);
        button.setTextSize(14);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setTextColor(primary ? 0xff241b36 : TEXT);
        button.setMinHeight(dp(50));
        button.setMinimumHeight(dp(50));
        button.setMinimumWidth(0);
        button.setPadding(dp(14), dp(10), dp(14), dp(10));
        button.setStateListAnimator(null);
        button.setBackground(ripple(rounded(primary ? ACCENT : 0xff213047,
                primary ? ACCENT : BORDER, 14), 14));
        return button;
    }

    final class Sheet {
        final Dialog dialog;
        final LinearLayout content;
        private final TextView error;
        private final LinearLayout footer;
        private final Button primary;
        private final Button secondary;
        private boolean primaryEnabled = true;
        private boolean busy;
        private String primaryTitle = "";

        Sheet(String eyebrow, String title, String description) {
            dialog = new Dialog(activity);
            dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
            dialog.setCanceledOnTouchOutside(true);

            // A wrap-content panel grows with content and shrinks above the keyboard.
            LinearLayout panel = new LinearLayout(activity) {
                @Override protected void onMeasure(int widthSpec, int heightSpec) {
                    Rect visible = new Rect();
                    activity.getWindow().getDecorView().getWindowVisibleDisplayFrame(visible);
                    int screenHeight = activity.getResources().getDisplayMetrics().heightPixels;
                    int visibleHeight = visible.height() > 0 ? visible.height() : screenHeight;
                    int cap = Math.max(dp(220), Math.min(screenHeight - dp(64), visibleHeight - dp(24)));
                    int supplied = View.MeasureSpec.getSize(heightSpec);
                    if (View.MeasureSpec.getMode(heightSpec) != View.MeasureSpec.UNSPECIFIED && supplied > 0) {
                        cap = Math.min(cap, supplied);
                    }
                    super.onMeasure(widthSpec, View.MeasureSpec.makeMeasureSpec(cap, View.MeasureSpec.AT_MOST));
                }
            };
            panel.setOrientation(LinearLayout.VERTICAL);
            panel.setPadding(dp(22), dp(12), dp(22), dp(20));
            panel.setFocusableInTouchMode(true);
            GradientDrawable panelSurface = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                    new int[]{0xff19283d, 0xff101b2b});
            panelSurface.setCornerRadius(dp(26));
            panelSurface.setStroke(dp(1), BORDER);
            panel.setBackground(panelSurface);

            View handle = new View(activity);
            handle.setBackground(rounded(0xff506078, Color.TRANSPARENT, 4));
            LinearLayout.LayoutParams handleLayout = new LinearLayout.LayoutParams(dp(34), dp(4));
            handleLayout.gravity = Gravity.CENTER_HORIZONTAL;
            handleLayout.bottomMargin = dp(20);
            panel.addView(handle, handleLayout);

            LinearLayout header = new LinearLayout(activity);
            header.setGravity(Gravity.TOP);
            LinearLayout titles = new LinearLayout(activity);
            titles.setOrientation(LinearLayout.VERTICAL);
            if (eyebrow != null && !eyebrow.isEmpty()) {
                TextView small = text(eyebrow, 10, ACCENT);
                small.setLetterSpacing(.16f);
                small.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
                LinearLayout.LayoutParams smallLayout = new LinearLayout.LayoutParams(-1, -2);
                smallLayout.bottomMargin = dp(9);
                titles.addView(small, smallLayout);
            }
            TextView heading = text(title, 23, TEXT);
            heading.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
            heading.setLineSpacing(dp(3), 1f);
            if (Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
            titles.addView(heading, new LinearLayout.LayoutParams(-1, -2));
            header.addView(titles, new LinearLayout.LayoutParams(0, -2, 1f));
            Button close = footerButton(false);
            close.setText("×");
            close.setTextSize(25);
            close.setTypeface(Typeface.DEFAULT, Typeface.NORMAL);
            close.setMinHeight(0);
            close.setMinimumHeight(0);
            close.setPadding(0, 0, 0, dp(2));
            close.setContentDescription("关闭弹窗");
            close.setOnClickListener(view -> dismiss());
            LinearLayout.LayoutParams closeLayout = new LinearLayout.LayoutParams(dp(44), dp(44));
            closeLayout.leftMargin = dp(12);
            header.addView(close, closeLayout);
            panel.addView(header, new LinearLayout.LayoutParams(-1, -2));

            if (description != null && !description.isEmpty()) {
                TextView descriptionView = text(description, 13, MUTED);
                descriptionView.setLineSpacing(dp(4), 1f);
                LinearLayout.LayoutParams descriptionLayout = new LinearLayout.LayoutParams(-1, -2);
                descriptionLayout.topMargin = dp(12);
                panel.addView(descriptionView, descriptionLayout);
            }

            ScrollView scroller = new ScrollView(activity);
            scroller.setFillViewport(false);
            scroller.setClipToPadding(false);
            scroller.setVerticalScrollBarEnabled(false);
            scroller.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
            content = new LinearLayout(activity);
            content.setOrientation(LinearLayout.VERTICAL);
            scroller.addView(content, new ScrollView.LayoutParams(-1, -2));
            LinearLayout.LayoutParams scrollLayout = new LinearLayout.LayoutParams(-1, -2, 1f);
            scrollLayout.topMargin = dp(22);
            panel.addView(scroller, scrollLayout);

            error = text("", 12, 0xffedb5bd);
            error.setLineSpacing(dp(3), 1f);
            error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
            error.setPadding(dp(12), dp(10), dp(12), dp(10));
            error.setBackground(rounded(0x303d263b, 0x604f3c54, 12));
            error.setVisibility(View.GONE);
            LinearLayout.LayoutParams errorLayout = new LinearLayout.LayoutParams(-1, -2);
            errorLayout.topMargin = dp(10);
            panel.addView(error, errorLayout);

            footer = new LinearLayout(activity);
            footer.setGravity(Gravity.CENTER_VERTICAL);
            primary = footerButton(true);
            secondary = footerButton(false);
            secondary.setVisibility(View.GONE);
            primary.setVisibility(View.GONE);
            footer.addView(secondary, new LinearLayout.LayoutParams(0, -2, 1f));
            LinearLayout.LayoutParams primaryLayout = new LinearLayout.LayoutParams(0, -2, 1f);
            primaryLayout.leftMargin = dp(10);
            footer.addView(primary, primaryLayout);
            footer.setVisibility(View.GONE);
            LinearLayout.LayoutParams footerLayout = new LinearLayout.LayoutParams(-1, -2);
            footerLayout.topMargin = dp(18);
            panel.addView(footer, footerLayout);
            dialog.setContentView(panel);

            Window window = dialog.getWindow();
            if (window != null) {
                window.setBackgroundDrawableResource(android.R.color.transparent);
                window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                        | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
                window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
                WindowManager.LayoutParams attributes = window.getAttributes();
                attributes.dimAmount = .66f;
                window.setAttributes(attributes);
            }
        }

        void show() {
            if (activity.isFinishing() || activity.isDestroyed()) return;
            dialog.show();
            Window window = dialog.getWindow();
            if (window != null) {
                int screenWidth = activity.getResources().getDisplayMetrics().widthPixels;
                boolean compact = screenWidth < dp(600);
                window.setLayout(Math.min(screenWidth - dp(24), dp(520)), ViewGroup.LayoutParams.WRAP_CONTENT);
                window.setGravity(compact ? Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL : Gravity.CENTER);
                WindowManager.LayoutParams attributes = window.getAttributes();
                attributes.y = compact ? dp(12) : 0;
                window.setAttributes(attributes);
            }
        }

        void dismiss() {
            dialog.dismiss();
        }

        void setPrimary(String title, Runnable action) {
            primaryTitle = title;
            if (!busy) primary.setText(title);
            primary.setVisibility(View.VISIBLE);
            primary.setOnClickListener(view -> {
                if (primaryEnabled && !busy && action != null) action.run();
            });
            footer.setVisibility(View.VISIBLE);
            updateFooter();
            setPrimaryEnabled(primaryEnabled);
        }

        void setSecondary(String title, Runnable action) {
            secondary.setText(title);
            secondary.setVisibility(View.VISIBLE);
            secondary.setOnClickListener(view -> {
                if (action != null) action.run();
                else dismiss();
            });
            footer.setVisibility(View.VISIBLE);
            updateFooter();
        }

        void setError(String message) {
            error.setText(message == null ? "" : message);
            error.setVisibility(message == null || message.isEmpty() ? View.GONE : View.VISIBLE);
        }

        void setPrimaryEnabled(boolean enabled) {
            primaryEnabled = enabled;
            primary.setEnabled(enabled && !busy);
            primary.setAlpha(enabled && !busy ? 1f : .55f);
        }

        void setBusy(boolean value, String label) {
            busy = value;
            primary.setText(value && label != null && !label.isEmpty() ? label : primaryTitle);
            setPrimaryEnabled(primaryEnabled);
        }

        private void updateFooter() {
            LinearLayout.LayoutParams primaryLayout = (LinearLayout.LayoutParams) primary.getLayoutParams();
            primaryLayout.leftMargin = secondary.getVisibility() == View.VISIBLE ? dp(10) : 0;
            primary.setLayoutParams(primaryLayout);
        }
    }
}
