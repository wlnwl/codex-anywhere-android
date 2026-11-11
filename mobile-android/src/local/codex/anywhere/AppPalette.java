package local.codex.anywhere;

import android.content.Context;
import android.view.View;
import android.view.Window;

/** Shared day and night colors for the native app. */
final class AppPalette {
    static final AppPalette DAY = new AppPalette(true);
    static final AppPalette NIGHT = new AppPalette(false);
    private static final String PREFERENCES = "appearance";
    private static final String DAY_MODE = "day_mode";

    final boolean day;
    final int canvasStart, canvasEnd, text, muted, hint, accent, onAccent;
    final int border, softBorder, statusSurface, buttonSurface;
    final int inputSurface, focusedSurface, cardSurface, selectedSurface, selectedMuted;
    final int dialogStart, dialogEnd, sidebarSurface, indicatorOutline, sheetHandle;
    final int ripple, highlight, error, errorSurface, errorBorder;

    private AppPalette(boolean day) {
        this.day = day;
        canvasStart = day ? 0xfff7f9ff : 0xff192336;
        canvasEnd = day ? 0xffe9eef8 : 0xff0a121f;
        text = day ? 0xff222c3e : 0xffe4ebf4;
        muted = day ? 0xff536278 : 0xffaebbd1;
        hint = day ? 0xff5f6f86 : 0xff8596ad;
        accent = day ? 0xff684497 : 0xffc8b2ea;
        onAccent = day ? 0xffffffff : 0xff241b36;
        border = day ? 0xffc5d0e0 : 0xff39495f;
        softBorder = day ? 0xffd4ddeb : 0x408699b5;
        statusSurface = day ? 0xffe8edf7 : 0x402b3c54;
        buttonSurface = day ? 0xffedf1f9 : 0xff213047;
        inputSurface = day ? 0xffffffff : 0xff111e30;
        focusedSurface = day ? 0xfff5f0fc : 0xff1b2a40;
        cardSurface = day ? 0xfff9fbff : 0xff1b2a3f;
        selectedSurface = day ? 0xffede4f7 : 0xff302d45;
        selectedMuted = day ? 0xff59496d : 0xffc7bdd8;
        dialogStart = day ? 0xfffcfdff : 0xff19283d;
        dialogEnd = day ? 0xffedf2fa : 0xff101b2b;
        sidebarSurface = day ? 0xfff3f6fc : 0xff162337;
        indicatorOutline = day ? 0xff7a879a : 0xff617189;
        sheetHandle = day ? 0xffa2afc1 : 0xff506078;
        ripple = day ? 0x25684497 : 0x20c8b2ea;
        highlight = day ? 0x40684497 : 0x55c8b2ea;
        error = day ? 0xff90293d : 0xffedb5bd;
        errorSurface = day ? 0xfff9e5eb : 0x303d263b;
        errorBorder = day ? 0xffe9b9c6 : 0x604f3c54;
    }

    static AppPalette read(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .getBoolean(DAY_MODE, false) ? DAY : NIGHT;
    }

    void save(Context context) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .edit().putBoolean(DAY_MODE, day).apply();
    }

    @SuppressWarnings("deprecation")
    void applySystemBars(Window window) {
        window.setStatusBarColor(canvasStart);
        window.setNavigationBarColor(canvasEnd);
        View decor = window.getDecorView();
        int lightBars = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        int flags = decor.getSystemUiVisibility() & ~lightBars;
        decor.setSystemUiVisibility(day ? flags | lightBars : flags);
    }
}
