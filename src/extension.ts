import * as vscode from 'vscode';
import branding from '../branding.json';

const CONFIG_SECTION = 'ikuncode-pulse';
const QUOTA_PER_CNY = 500000;
const DEFAULT_REFRESH_SECONDS = 60;
const RECENT_WINDOW_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 300;
const BACKOFF_STEP_SECONDS = 60;
const SPEND_HIGHLIGHT_DURATION_MS = 6000;
const SPEND_HIGHLIGHT_COLOR = '#31EB87';
const WARNING_BACKGROUND = new vscode.ThemeColor('statusBarItem.warningBackground');
const WARNING_FOREGROUND = new vscode.ThemeColor('statusBarItem.warningForeground');
const ERROR_BACKGROUND = new vscode.ThemeColor('statusBarItem.errorBackground');
const ERROR_FOREGROUND = new vscode.ThemeColor('statusBarItem.errorForeground');

type RefreshReason = 'startup' | 'timer' | 'manual' | 'config';
type RefreshMode = 'light' | 'heavy';

interface ExtensionConfig {
  baseApiUrl: string;
  userId: string;
  accessToken: string;
  siteName?: string;
  siteUrl?: string;
  refreshSeconds: number;
  enableAnimation: boolean;
}

interface ApiEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
}

interface UserSelfData {
  username?: string;
  display_name?: string;
  group?: string;
  quota?: number;
  used_quota?: number;
  request_count?: number;
}

interface LogStatData {
  quota?: number;
  rpm?: number;
  tpm?: number;
}

interface BalanceSnapshot {
  username: string;
  displayName: string;
  accountGroup: string;
  remainingQuota: number;
  usedQuota: number;
  totalQuota: number;
  remainingCny: number;
  usedCny: number;
  totalCny: number;
  requestCount: number;
}

interface SpendWindowSnapshot {
  startTime: Date;
  endTime: Date;
  quota: number;
  cny: number;
  rpm: number;
  tpm: number;
}

interface ValidationResult {
  ok: boolean;
  message?: string;
}

class NewApiClient {
  public async getUserSelf(config: ExtensionConfig): Promise<UserSelfData> {
    return this.request<UserSelfData>(config, '/user/self');
  }

  public async getLogStat(
    config: ExtensionConfig,
    startTimestamp: number,
    endTimestamp: number,
  ): Promise<LogStatData> {
    return this.request<LogStatData>(config, '/log/self/stat', {
      start_timestamp: startTimestamp,
      end_timestamp: endTimestamp,
    });
  }

  private async request<T>(
    config: ExtensionConfig,
    path: string,
    params?: Record<string, string | number>,
  ): Promise<T> {
    const baseUrl = config.baseApiUrl.replace(/\/+$/, '');
    const url = new URL(`${baseUrl}${path}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.accessToken}`,
        'New-Api-User': config.userId,
      },
      signal: AbortSignal.timeout(15_000),
    });

    const bodyText = await response.text();
    let payload: ApiEnvelope<T>;

    try {
      payload = JSON.parse(bodyText) as ApiEnvelope<T>;
    } catch {
      throw new Error(response.ok ? '接口返回了无法识别的内容。' : `请求失败：HTTP ${response.status}`);
    }

    if (!response.ok || payload.success === false) {
      throw new Error(payload.message || `请求失败：HTTP ${response.status}`);
    }

    if (payload.data === undefined) {
      throw new Error('接口返回里缺少 data 字段。');
    }

    return payload.data;
  }
}

class AiTokenPulseController implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly client = new NewApiClient();
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer?: NodeJS.Timeout;
  private animationTimer?: NodeJS.Timeout;
  private isRefreshing = false;
  private animationSpendCny?: number;
  private sessionStartedAtMs = Date.now();
  private lastSessionCheckAtMs = this.sessionStartedAtMs;
  private lastRefreshAt?: Date;
  private lastRefreshDurationMs?: number;
  private lastError?: string;
  private latestBalance?: BalanceSnapshot;
  private latestRecentWindow?: SpendWindowSnapshot;
  private latestTodayWindow?: SpendWindowSnapshot;
  private sessionCostCny = 0;
  private consecutiveFailureCount = 0;
  private currentRefreshDelaySeconds = DEFAULT_REFRESH_SECONDS;
  private config = this.readConfig();

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    this.statusBarItem.name = branding.displayName;
    this.statusBarItem.command = 'ikuncode-pulse.refresh';
    this.statusBarItem.show();

    this.disposables.push(this.statusBarItem);
    this.registerCommands();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          void this.handleConfigurationChange();
        }
      }),
    );
  }

  public async initialize(): Promise<void> {
    this.renderStatusBar();
    await this.refresh('startup', 'heavy', false);
  }

  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    if (this.animationTimer) {
      clearTimeout(this.animationTimer);
    }

    vscode.Disposable.from(...this.disposables).dispose();
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand('ikuncode-pulse.refresh', async () => {
        await this.refresh('manual', 'heavy', true);
      }),
      vscode.commands.registerCommand('ikuncode-pulse.openSettings', async () => {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'ikuncode-pulse');
      }),
    );
  }

  private readConfig(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

    return {
      baseApiUrl: String(config.get<string>('baseApiUrl', branding.defaultBaseApiUrl)).trim(),
      userId: String(config.get<string>('userId', '')).trim(),
      accessToken: String(config.get<string>('accessToken', '')).trim(),
      siteName: String(config.get<string>('siteName', branding.defaultSiteName)).trim(),
      siteUrl: String(config.get<string>('siteUrl', branding.defaultSiteUrl)).trim(),
      refreshSeconds: Math.max(10, Number(config.get<number>('refreshSeconds', DEFAULT_REFRESH_SECONDS) || DEFAULT_REFRESH_SECONDS)),
      enableAnimation: Boolean(config.get<boolean>('enableAnimation', true)),
    };
  }

  private validateConfig(config: ExtensionConfig): ValidationResult {
    if (!config.baseApiUrl) {
      return { ok: false, message: '请先在用户设置里填写 ikuncode-pulse.baseApiUrl。' };
    }

    if (!config.userId) {
      return { ok: false, message: '请先在用户设置里填写 ikuncode-pulse.userId。' };
    }

    if (!config.accessToken) {
      return { ok: false, message: '请先在用户设置里填写 ikuncode-pulse.accessToken。' };
    }

    try {
      new URL(config.baseApiUrl);
    } catch {
      return { ok: false, message: 'ikuncode-pulse.baseApiUrl 不是合法地址。' };
    }

    if (config.siteUrl && !this.getValidatedSiteUrl(config.siteUrl)) {
      return { ok: false, message: 'ikuncode-pulse.siteUrl 不是合法的 http/https 地址。' };
    }

    return { ok: true };
  }

  private async handleConfigurationChange(): Promise<void> {
    const previousConfig = this.config;
    this.config = this.readConfig();
    const identityChanged =
      previousConfig.baseApiUrl !== this.config.baseApiUrl ||
      previousConfig.userId !== this.config.userId ||
      previousConfig.accessToken !== this.config.accessToken;

    if (identityChanged) {
      this.resetSessionState();
    }

    this.currentRefreshDelaySeconds = this.config.refreshSeconds;
    this.clearRefreshTimer();
    this.renderStatusBar();
    await this.refresh('config', 'heavy', identityChanged);
  }

  private resetSessionState(): void {
    this.sessionStartedAtMs = Date.now();
    this.lastSessionCheckAtMs = this.sessionStartedAtMs;
    this.sessionCostCny = 0;
    this.latestBalance = undefined;
    this.latestRecentWindow = undefined;
    this.latestTodayWindow = undefined;
    this.lastRefreshAt = undefined;
    this.lastRefreshDurationMs = undefined;
    this.lastError = undefined;
    this.consecutiveFailureCount = 0;
    this.currentRefreshDelaySeconds = this.config.refreshSeconds;
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private scheduleNextRefresh(): void {
    this.clearRefreshTimer();

    this.refreshTimer = setTimeout(() => {
      void this.refresh('timer', 'light', true);
    }, this.currentRefreshDelaySeconds * 1000);
  }

  private async refresh(reason: RefreshReason, mode: RefreshMode, includeSessionDelta: boolean): Promise<void> {
    const validation = this.validateConfig(this.config);
    if (!validation.ok) {
      this.lastError = validation.message;
      this.clearRefreshTimer();
      this.renderStatusBar();
      return;
    }

    if (this.isRefreshing) {
      return;
    }

    this.isRefreshing = true;
    this.renderStatusBar();

    const refreshStartedAt = Date.now();
    const now = Date.now();
    const refreshEndTimestamp = Math.floor(now / 1000);
    const refreshStartTimestamp = Math.floor(this.lastSessionCheckAtMs / 1000);
    const todayStartTimestamp = getLocalDayStartTimestamp(now);

    const deltaPromise = includeSessionDelta && refreshStartTimestamp < refreshEndTimestamp
      ? this.client.getLogStat(this.config, refreshStartTimestamp, refreshEndTimestamp)
      : Promise.resolve<LogStatData | undefined>(undefined);
    const balancePromise = mode === 'heavy'
      ? this.client.getUserSelf(this.config)
      : Promise.resolve<UserSelfData | undefined>(undefined);
    const todayPromise = mode === 'heavy'
      ? this.client.getLogStat(this.config, todayStartTimestamp, refreshEndTimestamp)
      : Promise.resolve<LogStatData | undefined>(undefined);
    const [balanceResult, todayResult, sessionResult] = await Promise.allSettled([
      balancePromise,
      todayPromise,
      deltaPromise,
    ]);

    try {
      let refreshedAny = false;
      const coreSucceeded = sessionResult.status === 'fulfilled';

      if (balanceResult.status === 'fulfilled' && balanceResult.value) {
        this.latestBalance = this.toBalanceSnapshot(balanceResult.value);
        refreshedAny = true;
      }

      if (todayResult.status === 'fulfilled' && todayResult.value) {
        this.latestTodayWindow = this.toSpendWindowSnapshot(todayResult.value, todayStartTimestamp, refreshEndTimestamp);
        refreshedAny = true;
      }

      if (sessionResult.status === 'fulfilled' && sessionResult.value) {
        const deltaCost = quotaToCny(sessionResult.value.quota ?? 0);
        this.latestRecentWindow = this.toSpendWindowSnapshot(sessionResult.value, refreshStartTimestamp, refreshEndTimestamp);
        if (deltaCost > 0) {
          this.sessionCostCny += deltaCost;
          if (mode === 'light') {
            this.applyEstimatedDelta(deltaCost);
          }
          if (reason !== 'startup') {
            if (this.config.enableAnimation) {
              this.startSpendAnimation(deltaCost);
            }
          }
        }
        this.lastSessionCheckAtMs = now;
        refreshedAny = true;
      }

      if (!refreshedAny) {
        const errors = [balanceResult, todayResult, sessionResult]
          .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
          .map((item) => errorMessageOf(item.reason));
        throw new Error(errors.join('；') || '刷新失败。');
      }

      const errors = [balanceResult, todayResult, sessionResult]
        .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
        .map((item) => errorMessageOf(item.reason));

      this.lastError = errors.length > 0 ? errors.join('；') : undefined;
      this.lastRefreshAt = new Date(now);
      this.lastRefreshDurationMs = Date.now() - refreshStartedAt;

      if (coreSucceeded) {
        this.consecutiveFailureCount = 0;
        this.currentRefreshDelaySeconds = this.config.refreshSeconds;
      } else {
        this.consecutiveFailureCount += 1;
        this.currentRefreshDelaySeconds = this.computeNextRefreshDelaySeconds();
      }
    } catch (error) {
      this.lastError = errorMessageOf(error);
      this.lastRefreshDurationMs = Date.now() - refreshStartedAt;
      this.consecutiveFailureCount += 1;
      this.currentRefreshDelaySeconds = this.computeNextRefreshDelaySeconds();
    } finally {
      this.isRefreshing = false;
      this.scheduleNextRefresh();
      this.renderStatusBar();
    }
  }

  private computeNextRefreshDelaySeconds(): number {
    if (this.consecutiveFailureCount <= 1) {
      return this.config.refreshSeconds;
    }

    return Math.min(
      MAX_BACKOFF_SECONDS,
      this.config.refreshSeconds + (this.consecutiveFailureCount - 1) * BACKOFF_STEP_SECONDS,
    );
  }

  private applyEstimatedDelta(deltaCost: number): void {
    if (deltaCost <= 0) {
      return;
    }

    if (this.latestBalance) {
      const remainingCny = Math.max(0, this.latestBalance.remainingCny - deltaCost);
      const usedCny = this.latestBalance.usedCny + deltaCost;

      this.latestBalance = {
        ...this.latestBalance,
        remainingCny,
        usedCny,
        totalCny: this.latestBalance.totalCny,
        remainingQuota: cnyToQuota(remainingCny),
        usedQuota: cnyToQuota(usedCny),
        totalQuota: cnyToQuota(this.latestBalance.totalCny),
      };
    }

    if (this.latestTodayWindow) {
      const todayCny = this.latestTodayWindow.cny + deltaCost;
      this.latestTodayWindow = {
        ...this.latestTodayWindow,
        cny: todayCny,
        quota: cnyToQuota(todayCny),
      };
    }
  }

  private startSpendAnimation(spendCny: number): void {
    this.animationSpendCny = spendCny;
    if (this.animationTimer) {
      clearTimeout(this.animationTimer);
    }

    this.renderStatusBar();
    this.animationTimer = setTimeout(() => {
      this.animationSpendCny = undefined;
      this.renderStatusBar();
    }, SPEND_HIGHLIGHT_DURATION_MS);
  }

  private renderStatusBar(): void {
    const validation = this.validateConfig(this.config);
    const recentSpendText = this.latestRecentWindow ? formatCny6(this.latestRecentWindow.cny) : '尚未查询';

    if (!validation.ok) {
      this.applyStatusBarAppearance({
        backgroundColor: WARNING_BACKGROUND,
        color: WARNING_FOREGROUND,
      });
      this.statusBarItem.text = `$(gear) 配置 ${branding.displayName}`;
      this.statusBarItem.tooltip = this.buildTooltip(validation.message, recentSpendText);
      return;
    }

    this.applyStatusBarAppearance();

    const remainingText = this.latestBalance ? formatCny2(this.latestBalance.remainingCny) : '¥--.--';
    const sessionText = formatCny6(this.sessionCostCny);
    const defaultText = `余额：${remainingText} · 当前会话：${sessionText}`;

    if (this.animationSpendCny !== undefined) {
      this.applyStatusBarAppearance({
        color: SPEND_HIGHLIGHT_COLOR,
      });
      this.statusBarItem.text = `$(sync~spin) 最新消耗：${formatCny6(this.animationSpendCny)}`;
    } else if (this.isRefreshing) {
      this.statusBarItem.text = `$(sync~spin) ${defaultText}`;
    } else if (this.lastError) {
      this.applyStatusBarAppearance(
        this.latestBalance
          ? {
              backgroundColor: WARNING_BACKGROUND,
              color: WARNING_FOREGROUND,
            }
          : {
              backgroundColor: ERROR_BACKGROUND,
              color: ERROR_FOREGROUND,
            },
      );
      this.statusBarItem.text = this.latestBalance
        ? `$(warning) ${defaultText}`
        : `$(warning) ${branding.displayName} 异常`;
    } else {
      this.statusBarItem.text = defaultText;
    }

    this.statusBarItem.tooltip = this.buildTooltip(this.lastError, recentSpendText);
  }

  private applyStatusBarAppearance(options?: {
    backgroundColor?: vscode.ThemeColor;
    color?: string | vscode.ThemeColor;
  }): void {
    this.statusBarItem.backgroundColor = options?.backgroundColor;
    this.statusBarItem.color = options?.color;
  }

  private buildTooltip(errorMessage: string | undefined, recentSpendText: string): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = true;
    markdown.supportHtml = false;

    const rows: Array<[string, string]> = [];

    if (this.latestBalance) {
      rows.push(['账户', escapeMarkdown(this.latestBalance.username || '-')]);
      rows.push(['显示名', escapeMarkdown(this.latestBalance.displayName || '-')]);
      rows.push(['分组', escapeMarkdown(this.latestBalance.accountGroup || '-')]);
      rows.push(['剩余额度', formatCny2(this.latestBalance.remainingCny)]);
      rows.push(['已用额度', formatCny2(this.latestBalance.usedCny)]);
      rows.push(['总额度', formatCny2(this.latestBalance.totalCny)]);
      rows.push(['请求次数', String(this.latestBalance.requestCount)]);
    } else {
      rows.push(['余额', '尚未成功获取']);
    }

    rows.push(['当前会话', formatCny6(this.sessionCostCny)]);
    rows.push(['本次刷新花费', recentSpendText]);
    rows.push(['今日花费', this.latestTodayWindow ? formatCny6(this.latestTodayWindow.cny) : '尚未查询']);

    if (this.latestRecentWindow) {
      rows.push(['最近 RPM', String(this.latestRecentWindow.rpm)]);
      rows.push(['最近 TPM', String(this.latestRecentWindow.tpm)]);
    }

    rows.push(['上次刷新', this.lastRefreshAt ? escapeMarkdown(formatDateTime(this.lastRefreshAt)) : '尚未刷新']);
    rows.push(['刷新耗时', this.lastRefreshDurationMs !== undefined ? `${this.lastRefreshDurationMs} ms` : '尚未刷新']);
    rows.push(['当前轮询间隔', `${this.currentRefreshDelaySeconds} 秒`]);
    rows.push(['连续失败次数', String(this.consecutiveFailureCount)]);

    if (errorMessage) {
      rows.push(['最近错误', escapeMarkdown(errorMessage)]);
    }

    markdown.appendMarkdown('| 项目 | 内容 |\n');
    markdown.appendMarkdown('| --- | --- |\n');
    for (const [label, value] of rows) {
      markdown.appendMarkdown(`| ${label} | ${value} |\n`);
    }

    return markdown;
  }

  private toBalanceSnapshot(data: UserSelfData): BalanceSnapshot {
    const remainingQuota = data.quota ?? 0;
    const usedQuota = data.used_quota ?? 0;
    const totalQuota = remainingQuota + usedQuota;

    return {
      username: data.username ?? '',
      displayName: data.display_name ?? '',
      accountGroup: data.group ?? '',
      remainingQuota,
      usedQuota,
      totalQuota,
      remainingCny: quotaToCny(remainingQuota),
      usedCny: quotaToCny(usedQuota),
      totalCny: quotaToCny(totalQuota),
      requestCount: data.request_count ?? 0,
    };
  }

  private toSpendWindowSnapshot(data: LogStatData, startTimestamp: number, endTimestamp: number): SpendWindowSnapshot {
    const quota = data.quota ?? 0;

    return {
      startTime: new Date(startTimestamp * 1000),
      endTime: new Date(endTimestamp * 1000),
      quota,
      cny: quotaToCny(quota),
      rpm: data.rpm ?? 0,
      tpm: data.tpm ?? 0,
    };
  }

  private getValidatedSiteUrl(siteUrl: string | undefined): string | undefined {
    if (!siteUrl) {
      return undefined;
    }

    try {
      const url = new URL(siteUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return undefined;
      }
      return url.toString();
    } catch {
      return undefined;
    }
  }

}

let controller: AiTokenPulseController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  controller = new AiTokenPulseController(context);
  context.subscriptions.push(controller);
  await controller.initialize();
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}

function quotaToCny(quota: number): number {
  return quota / QUOTA_PER_CNY;
}

function cnyToQuota(cny: number): number {
  return Math.round(cny * QUOTA_PER_CNY);
}

function formatCny2(value: number): string {
  return `¥${value.toFixed(2)}`;
}

function formatCny6(value: number): string {
  return `¥${value.toFixed(6)}`;
}

function formatDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function getLocalDayStartTimestamp(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
