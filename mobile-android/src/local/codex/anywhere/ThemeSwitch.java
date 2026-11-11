package local.codex.anywhere;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.animation.AccelerateDecelerateInterpolator;

/** A recessed switch with a raised thumb and pixel sun/moon transition. */
final class ThemeSwitch extends View {
    interface Listener { void onDayModeChanged(boolean day); }

    private static final String[] MOON = {
        "..###....", ".###.....", "###......", "###......", "###.....#",
        ".###...##", ".#######.", "..#####..", "........."
    };
    private static final String[] SUN = {
        "....#....", ".#.....#.", "..#####..", "..#####..", "#.#####.#",
        "..#####..", "..#####..", ".#.....#.", "....#...."
    };
    private static final RectF TRACK = new RectF(2, 6, 74, 42);
    private static final float NIGHT_CENTER = 56;
    private static final float DAY_CENTER = 20;
    private static final float CENTER_Y = 24;
    private static final long DURATION_MS = 520;

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path trackClip = new Path();
    private boolean day;
    private float position;
    private ValueAnimator animator;

    ThemeSwitch(Context context, boolean day, Listener listener) {
        super(context);
        this.day = day;
        position = day ? 1f : 0f;
        trackClip.addRoundRect(TRACK, 18, 18, Path.Direction.CW);
        setFocusable(true);
        setClickable(true);
        describeState();
        setOnClickListener(view -> {
            this.day = !this.day;
            describeState();
            slideTo(this.day ? 1f : 0f);
            listener.onDayModeChanged(this.day);
        });
    }

    private void describeState() {
        String next = day ? "切换到夜间模式" : "切换到日间模式";
        setContentDescription((day ? "当前为日间模式，" : "当前为夜间模式，") + next);
        setTooltipText(next);
    }

    private void slideTo(float target) {
        if (animator != null) animator.cancel();
        if (!ValueAnimator.areAnimatorsEnabled()) {
            position = target;
            invalidate();
            return;
        }
        animator = ValueAnimator.ofFloat(position, target);
        animator.setDuration(Math.max(100L, Math.round(DURATION_MS * Math.abs(target - position))));
        animator.setInterpolator(new AccelerateDecelerateInterpolator());
        animator.addUpdateListener(animation -> {
            position = (float) animation.getAnimatedValue();
            invalidate();
        });
        animator.start();
    }

    @Override protected void onDetachedFromWindow() {
        if (animator != null) animator.cancel();
        position = day ? 1f : 0f;
        super.onDetachedFromWindow();
    }

    @Override public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(info);
        info.setClassName("android.widget.Switch");
        info.setCheckable(true);
        info.setChecked(day);
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float density = getResources().getDisplayMetrics().density;
        float scale = Math.min(density, Math.min(getWidth() / 76f, getHeight() / 48f));
        if (scale <= 0f) return;
        canvas.save();
        canvas.translate((getWidth() - 76f * scale) / 2f, (getHeight() - 48f * scale) / 2f);
        canvas.scale(scale, scale);
        drawTrack(canvas);
        canvas.save();
        canvas.clipPath(trackClip);
        float thumb = NIGHT_CENTER + (DAY_CENTER - NIGHT_CENTER) * position;
        drawThumb(canvas, thumb);
        drawPixels(canvas, MOON, thumb, true);
        drawPixels(canvas, SUN, thumb, false);
        canvas.restore();
        canvas.restore();
    }

    private void drawTrack(Canvas canvas) {
        paint.setColor(blend(0xff172131, 0xffded0b6, position));
        canvas.drawRoundRect(TRACK, 18, 18, paint);
        paint.setColor(blend(0xff0a101d, 0xffc3af8c, position));
        canvas.drawRoundRect(4, 7, 72, 39, 16, 16, paint);
        paint.setColor(blend(0xff111c2c, 0xfff0e2c6, position));
        canvas.drawRoundRect(5, 10, 71, 40, 15, 15, paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(isFocused() ? 1.6f : .8f);
        paint.setColor(isFocused() ? (day ? AppPalette.DAY.accent : AppPalette.NIGHT.accent)
                : blend(0xff43516a, 0xffbfae95, position));
        canvas.drawRoundRect(TRACK, 18, 18, paint);
        paint.setStyle(Paint.Style.FILL);
    }

    private void drawThumb(Canvas canvas, float center) {
        paint.setColor(0x36000000);
        canvas.drawCircle(center, CENTER_Y + 2.6f, 15.4f, paint);
        paint.setColor(0x24000000);
        canvas.drawCircle(center, CENTER_Y + 3.7f, 15.4f, paint);
        paint.setColor(blend(0xff607490, 0xffb49a65, position));
        canvas.drawCircle(center, CENTER_Y + .7f, 14.8f, paint);
        paint.setColor(blend(0xff293952, 0xfffff6dc, position));
        canvas.drawCircle(center, CENTER_Y - .7f, 14.2f, paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(.7f);
        paint.setColor(blend(0xff758ba8, 0xfffffcf1, position));
        canvas.drawCircle(center, CENTER_Y - .7f, 13.7f, paint);
        paint.setStyle(Paint.Style.FILL);
    }

    private void drawPixels(Canvas canvas, String[] icon, float center, boolean moon) {
        float alpha = moon ? 1f - smoothStep(.17f, .61f, position) : smoothStep(.39f, .83f, position);
        if (alpha < .01f) return;
        float spread = moon ? smoothStep(.07f, .65f, position) : 1f - smoothStep(.35f, .93f, position);
        int color = moon ? 0xffe3edff : 0xffaf6504;
        paint.setAntiAlias(false);
        for (int row = 0; row < icon.length; row++) {
            for (int column = 0; column < icon[row].length(); column++) {
                if (icon[row].charAt(column) != '#') continue;
                int seed = row * 23 + column * 13;
                float driftX = ((seed % 13) - 6) * 1.4f;
                float driftY = (((seed * 7) % 11) - 5) * 1.35f;
                float x = center + (column - 4) * 1.82f + spread * (driftX + (moon ? 3f : -3f));
                float y = CENTER_Y - .7f + (row - 4) * 1.82f + spread * driftY;
                float radius = .87f - spread * ((seed % 4) * .11f);
                paint.setColor(color);
                paint.setAlpha(Math.round(255f * alpha * (1f - spread * (seed % 3) * .12f)));
                canvas.drawRect(x - radius, y - radius, x + radius, y + radius, paint);
            }
        }
        paint.setAlpha(255);
        paint.setAntiAlias(true);
    }

    private static float smoothStep(float start, float end, float value) {
        float progress = Math.max(0f, Math.min(1f, (value - start) / (end - start)));
        return progress * progress * (3f - 2f * progress);
    }

    private static int blend(int from, int to, float fraction) {
        return Color.rgb(
                Math.round(Color.red(from) + (Color.red(to) - Color.red(from)) * fraction),
                Math.round(Color.green(from) + (Color.green(to) - Color.green(from)) * fraction),
                Math.round(Color.blue(from) + (Color.blue(to) - Color.blue(from)) * fraction));
    }
}
