'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Check,
  Code,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  Wifi,
  RefreshCw,
  Clock,
  Radio,
} from 'lucide-react';
import type {
  SupplierSourceDto,
  CreateSupplierSourceDto,
  TestConnectionResponseDto,
  SyncTriggerResponseDto,
  GetSyncStatusResponseDto,
  SyncStatusDto,
} from '@repo/shared-types';
import { apiClient } from '../lib/api-client';
import { useToast } from './Toast';

interface SupplierFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  supplier?: SupplierSourceDto | null;
}

const CONFIG_POOL_PRESET = JSON.stringify(
  {
    priceMap: {
      'netflix-premium-1-thang': '50000.00',
      'spotify-premium-1-thang': '40000.00',
    },
    credentialPool: ['KEY-DEMO-A1', 'KEY-DEMO-B2', 'KEY-DEMO-C3'],
  },
  null,
  2,
);

const WEB_SCRAPER_PRESET = JSON.stringify(
  {
    priceMap: {
      'chatgpt-plus-1-thang': '200000.00',
    },
    scrapingRules: {
      loginSelector: '#username',
      buyButtonSelector: '.checkout-btn',
    },
  },
  null,
  2,
);

const TELEGRAM_BOT_PRESET = JSON.stringify(
  {
    command: '/start',
    collect: {
      timeoutMs: 30000,
      idleMs: 1500,
      maxMessages: 20,
    },
  },
  null,
  2,
);

export function SupplierFormModal({
  isOpen,
  onClose,
  onSaved,
  supplier,
}: SupplierFormModalProps) {
  const { showToast } = useToast();
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState('');
  const [type, setType] = useState('CONFIG_POOL');
  const [targetUrl, setTargetUrl] = useState('');
  const [markupPercentage, setMarkupPercentage] = useState('10.00');
  const [markupFixedVnd, setMarkupFixedVnd] = useState('5000.00');
  const [isActive, setIsActive] = useState(true);

  // Structured fields for TELEGRAM_BOT
  const [botUsername, setBotUsername] = useState('');
  const [vndPerCredit, setVndPerCredit] = useState('1000');
  const [syncIntervalSec, setSyncIntervalSec] = useState('3600');
  const [botUsernameError, setBotUsernameError] = useState<string | null>(null);

  // Test connection state
  const [testingConnection, setTestingConnection] = useState(false);

  // Sync Now & Polling state
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatusDto | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Safe JSON state
  const [rawJson, setRawJson] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    setSyncing(false);
  };

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, []);

  // Reset or initialize state when supplier / isOpen changes
  useEffect(() => {
    stopPolling();
    setBotUsernameError(null);

    if (supplier) {
      setName(supplier.name);
      setType(supplier.type);
      setTargetUrl(supplier.targetUrl || '');
      setMarkupPercentage(supplier.markupPercentage || '0.00');
      setMarkupFixedVnd(supplier.markupFixedVnd || '0.00');
      setIsActive(supplier.isActive);

      if (supplier.type === 'TELEGRAM_BOT') {
        const creds = supplier.configCredentials ? { ...supplier.configCredentials } : {};
        setBotUsername(creds.botUsername ? String(creds.botUsername) : '');
        setVndPerCredit(
          creds.vndPerCredit !== undefined && creds.vndPerCredit !== null
            ? String(creds.vndPerCredit)
            : '1000',
        );
        setSyncIntervalSec(
          supplier.syncIntervalSec !== undefined && supplier.syncIntervalSec !== null
            ? String(supplier.syncIntervalSec)
            : '3600',
        );

        // Strip botUsername, vndPerCredit, syncIntervalSec from displayed rawJson
        delete creds.botUsername;
        delete creds.vndPerCredit;
        delete creds.syncIntervalSec;

        setRawJson(Object.keys(creds).length > 0 ? JSON.stringify(creds, null, 2) : '');

        setSyncStatus({
          isSyncing: false,
          lastSyncAt: supplier.lastSyncAt || null,
          lastSyncError: supplier.lastSyncError || null,
          consecutiveSyncFailures: supplier.consecutiveSyncFailures || 0,
          syncIntervalSec: supplier.syncIntervalSec || 3600,
        });
      } else {
        setBotUsername('');
        setVndPerCredit('1000');
        setSyncIntervalSec('3600');
        setSyncStatus(null);
        setRawJson(
          supplier.configCredentials
            ? JSON.stringify(supplier.configCredentials, null, 2)
            : '',
        );
      }
      setJsonError(null);
    } else {
      setName('');
      setType('CONFIG_POOL');
      setTargetUrl('');
      setMarkupPercentage('10.00');
      setMarkupFixedVnd('5000.00');
      setIsActive(true);
      setBotUsername('');
      setVndPerCredit('1000');
      setSyncIntervalSec('3600');
      setSyncStatus(null);
      setRawJson(CONFIG_POOL_PRESET);
      setJsonError(null);
    }
  }, [supplier, isOpen]);

  const handleTypeChange = (newType: string) => {
    setType(newType);
    setBotUsernameError(null);
    if (newType === 'TELEGRAM_BOT') {
      setRawJson(TELEGRAM_BOT_PRESET);
      setJsonError(null);
      if (!syncIntervalSec) setSyncIntervalSec('3600');
      if (!vndPerCredit) setVndPerCredit('1000');
    } else if (newType === 'CONFIG_POOL') {
      setRawJson(CONFIG_POOL_PRESET);
      setJsonError(null);
    } else if (newType === 'WEB_SCRAPER') {
      setRawJson(WEB_SCRAPER_PRESET);
      setJsonError(null);
    }
  };

  const handleBotUsernameChange = (val: string) => {
    setBotUsername(val);
    const clean = val.trim().replace(/^@+/, '');
    if (clean && !/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(clean)) {
      setBotUsernameError('Username bot phải bắt đầu bằng chữ cái, dài 5-32 ký tự (chữ, số, gạch dưới)');
    } else {
      setBotUsernameError(null);
    }
  };

  const validateJson = (text: string): boolean => {
    if (!text.trim()) {
      setJsonError(null);
      return true;
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setJsonError('JSON phải là một đối tượng (object), không được là mảng hay giá trị nguyên thủy');
        return false;
      }
      setJsonError(null);
      return true;
    } catch (err: any) {
      setJsonError(err.message || 'Cú pháp JSON không hợp lệ');
      return false;
    }
  };

  const handleJsonChange = (text: string) => {
    setRawJson(text);
    validateJson(text);
  };

  const handleFormatJson = () => {
    try {
      if (!rawJson.trim()) return;
      const parsed = JSON.parse(rawJson);
      setRawJson(JSON.stringify(parsed, null, 2));
      setJsonError(null);
      showToast('Đã format JSON');
    } catch (err: any) {
      setJsonError(err.message);
    }
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    try {
      const res = await apiClient.post<TestConnectionResponseDto>(
        '/api/admin/suppliers/test-connection',
        {},
      );
      if (res.ok) {
        showToast(`Kết nối relay thành công (Trạng thái: ${res.status || 'healthy'})`);
      } else {
        showToast(res.error || 'Kết nối relay thất bại', 'error');
      }
    } catch (err: any) {
      showToast(err?.message || 'Lỗi khi kiểm tra kết nối relay', 'error');
    } finally {
      setTestingConnection(false);
    }
  };

  const startPolling = (supplierId: string) => {
    stopPolling();
    setSyncing(true);
    setSyncStatus((prev) =>
      prev
        ? { ...prev, isSyncing: true }
        : {
            isSyncing: true,
            lastSyncAt: null,
            lastSyncError: null,
            consecutiveSyncFailures: 0,
            syncIntervalSec: parseInt(syncIntervalSec, 10) || 3600,
          },
    );

    // Timeout after 2 minutes
    pollTimeoutRef.current = setTimeout(() => {
      stopPolling();
      showToast('Đồng bộ mất nhiều thời gian hơn dự kiến (hết thời gian chờ). Vui lòng kiểm tra lại sau.', 'error');
    }, 120_000);

    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await apiClient.get<GetSyncStatusResponseDto>(
          `/api/admin/suppliers/${supplierId}/sync-status`,
        );
        if (res && res.ok && res.syncStatus) {
          setSyncStatus(res.syncStatus);
          if (!res.syncStatus.isSyncing) {
            stopPolling();
            if (res.syncStatus.lastSyncError) {
              showToast(`Đồng bộ thất bại: ${res.syncStatus.lastSyncError}`, 'error');
            } else {
              showToast('Đồng bộ catalog hoàn tất!');
            }
            onSaved();
          }
        }
      } catch (err: any) {
        stopPolling();
        showToast(err?.message || 'Lỗi kiểm tra trạng thái đồng bộ', 'error');
      }
    }, 3000);
  };

  const handleTriggerSync = async () => {
    if (!supplier?.id || syncing) return;

    try {
      const res = await apiClient.post<SyncTriggerResponseDto>(
        `/api/admin/suppliers/${supplier.id}/sync`,
        {},
      );
      showToast(`Đã kích hoạt đồng bộ (Job: ${res.jobId})`);
      startPolling(supplier.id);
    } catch (err: any) {
      if (err?.status === 409 || err?.body?.errorCode === 'SYNC_DEBOUNCED') {
        showToast(
          err?.body?.message || err?.message || 'Đồng bộ đang chạy hoặc trong thời gian chờ cooldown',
          'error',
        );
      } else {
        showToast(err?.message || 'Không thể kích hoạt đồng bộ', 'error');
      }
    }
  };

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      showToast('Vui lòng nhập tên nhà cung cấp', 'error');
      return;
    }

    if (!validateJson(rawJson)) {
      showToast('Vui lòng sửa lỗi cú pháp JSON trước khi lưu', 'error');
      return;
    }

    let parsedConfig: Record<string, any> | null = null;
    if (rawJson.trim()) {
      try {
        parsedConfig = JSON.parse(rawJson);
      } catch {
        showToast('Lỗi parse JSON config', 'error');
        return;
      }
    }

    let parsedInterval: number | undefined = undefined;

    if (type === 'TELEGRAM_BOT') {
      const cleanBot = botUsername.trim().replace(/^@+/, '');
      if (!cleanBot || !/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(cleanBot)) {
        showToast('Username bot không hợp lệ (5-32 ký tự, bắt đầu bằng chữ cái)', 'error');
        return;
      }

      const creditVal = Number(vndPerCredit);
      if (isNaN(creditVal) || creditVal <= 0) {
        showToast('Tỷ giá VND/credit phải lớn hơn 0', 'error');
        return;
      }

      parsedInterval = parseInt(syncIntervalSec, 10);
      if (isNaN(parsedInterval) || parsedInterval < 3600) {
        showToast('Chu kỳ đồng bộ tối thiểu là 3600 giây (1 giờ)', 'error');
        return;
      }

      if (!parsedConfig?.command && !parsedConfig?.interactionSteps) {
        showToast('JSON phải chứa command hoặc interactionSteps', 'error');
        return;
      }

      // HIGH-2: Structured fields AFTER spread to override any duplicate keys in parsedJson
      const mergedConfig = {
        ...(parsedConfig || {}),
        botUsername: cleanBot,
        vndPerCredit: creditVal,
      };
      delete (mergedConfig as any).syncIntervalSec;
      parsedConfig = mergedConfig;
    }

    const payload: CreateSupplierSourceDto = {
      name: name.trim(),
      type,
      targetUrl: targetUrl.trim() || null,
      markupPercentage,
      markupFixedVnd,
      configCredentials: parsedConfig,
      isActive,
      ...(parsedInterval !== undefined ? { syncIntervalSec: parsedInterval } : {}),
    };

    setSubmitting(true);
    try {
      if (supplier) {
        await apiClient.patch(`/api/admin/suppliers/${supplier.id}`, payload);
        showToast(`Đã cập nhật nhà cung cấp "${name}"`);
      } else {
        await apiClient.post('/api/admin/suppliers', payload);
        showToast(`Đã tạo nhà cung cấp "${name}"`);
      }
      onSaved();
      onClose();
    } catch (err: any) {
      showToast(err?.message || 'Có lỗi xảy ra khi lưu nhà cung cấp', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full p-6 shadow-2xl my-8">
        <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
          <div className="flex items-center gap-2 text-slate-100">
            <Code className="w-5 h-5 text-amber-400" />
            <h2 className="text-base font-bold">
              {supplier ? 'Chỉnh sửa nhà cung cấp' : 'Thêm nhà cung cấp mới'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
              Tên nhà cung cấp *
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="VD: Kho sỉ Digital Pro"
              className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-amber-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                Loại tích hợp
              </label>
              <select
                value={type}
                onChange={(e) => handleTypeChange(e.target.value)}
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 focus:outline-none focus:border-amber-500"
              >
                <option value="CONFIG_POOL">CONFIG_POOL (Kho key trong Config)</option>
                <option value="WEB_SCRAPER">WEB_SCRAPER (Scraper ngoài / Bot)</option>
                <option value="TELEGRAM_BOT">TELEGRAM_BOT (Cào danh mục Telegram Bot)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                Website / Target URL (Tùy chọn)
              </label>
              <input
                type="text"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://..."
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>

          {/* TELEGRAM_BOT Structured Configuration */}
          {type === 'TELEGRAM_BOT' && (
            <div className="p-4 bg-slate-950/70 border border-amber-500/30 rounded-xl space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-bold text-amber-400">
                  <Radio className="w-4 h-4" />
                  <span>Cấu hình Telegram Bot Scraper</span>
                </div>
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={testingConnection}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] font-semibold text-amber-300 hover:text-amber-200 border border-slate-700 transition-colors disabled:opacity-50"
                  title="Kiểm tra kết nối tới dịch vụ Telegram Relay"
                >
                  <Wifi className={`w-3.5 h-3.5 ${testingConnection ? 'animate-pulse text-amber-400' : ''}`} />
                  <span>{testingConnection ? 'Đang kiểm tra...' : 'Test Connection'}</span>
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-300 mb-1">
                    Bot Username *
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-2 text-xs text-slate-500 font-mono">@</span>
                    <input
                      type="text"
                      required
                      value={botUsername}
                      onChange={(e) => handleBotUsernameChange(e.target.value)}
                      placeholder="shop_key_bot"
                      className={`w-full pl-7 pr-3 py-1.5 bg-slate-900 border rounded-lg text-xs text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none ${
                        botUsernameError
                          ? 'border-rose-500 focus:border-rose-500'
                          : 'border-slate-700 focus:border-amber-500'
                      }`}
                    />
                  </div>
                  {botUsernameError && (
                    <p className="text-[10px] text-rose-400 mt-1 leading-tight">{botUsernameError}</p>
                  )}
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-300 mb-1">
                    Tỷ giá VND / 1 Credit *
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    required
                    value={vndPerCredit}
                    onChange={(e) => setVndPerCredit(e.target.value)}
                    placeholder="1000"
                    className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-100 font-mono focus:outline-none focus:border-amber-500"
                  />
                  <p className="text-[10px] text-slate-500 mt-0.5">Quy đổi số dư credit của bot sang VND</p>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Chu kỳ tự động đồng bộ (giây) *
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="3600"
                    step="60"
                    required
                    value={syncIntervalSec}
                    onChange={(e) => setSyncIntervalSec(e.target.value)}
                    placeholder="3600"
                    className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-100 font-mono focus:outline-none focus:border-amber-500"
                  />
                  <span className="text-xs text-slate-400 shrink-0">giây</span>
                </div>
                <p className="text-[10px] text-slate-500 mt-0.5">Tối thiểu 3600 giây (1 giờ)</p>
              </div>

              {/* Sync Status and Trigger for Saved Telegram Bot Suppliers */}
              {supplier?.id && (
                <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
                  <div className="text-xs space-y-0.5">
                    <div className="flex items-center gap-1.5 text-slate-300">
                      <Clock className="w-3.5 h-3.5 text-slate-400" />
                      <span className="font-medium">Trạng thái đồng bộ:</span>
                      {syncing || syncStatus?.isSyncing ? (
                        <span className="text-amber-400 font-medium flex items-center gap-1">
                          <RefreshCw className="w-3 h-3 animate-spin" />
                          Đang đồng bộ catalog...
                        </span>
                      ) : syncStatus?.lastSyncAt ? (
                        <span className="text-emerald-400 font-mono text-[11px]">
                          {new Date(syncStatus.lastSyncAt).toLocaleString('vi-VN')}
                        </span>
                      ) : (
                        <span className="text-slate-500 text-[11px]">Chưa từng đồng bộ</span>
                      )}
                    </div>
                    {/* MED-8: Suppress lastSyncError while syncing */}
                    {!syncing && !syncStatus?.isSyncing && syncStatus?.lastSyncError && (
                      <p className="text-[11px] text-rose-400 truncate max-w-sm">
                        Lỗi gần nhất: {syncStatus.lastSyncError}
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={handleTriggerSync}
                    disabled={syncing || Boolean(syncStatus?.isSyncing)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-xs font-semibold text-amber-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${syncing || syncStatus?.isSyncing ? 'animate-spin' : ''}`} />
                    <span>{syncing || syncStatus?.isSyncing ? 'Đang sync...' : 'Sync Now'}</span>
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                Markup phần trăm (%)
              </label>
              <input
                type="text"
                required
                value={markupPercentage}
                onChange={(e) => setMarkupPercentage(e.target.value)}
                placeholder="10.00"
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 font-mono focus:outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                Phụ phí cố định (VND)
              </label>
              <input
                type="text"
                required
                value={markupFixedVnd}
                onChange={(e) => setMarkupFixedVnd(e.target.value)}
                placeholder="5000.00"
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 font-mono focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>

          {/* Safe JSON Credentials Editor */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Config Credentials (JSON)
              </label>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleJsonChange(CONFIG_POOL_PRESET)}
                  className="px-2 py-0.5 rounded text-[11px] bg-slate-800 text-slate-300 hover:text-white"
                >
                  Mẫu Pool
                </button>
                <button
                  type="button"
                  onClick={() => handleJsonChange(WEB_SCRAPER_PRESET)}
                  className="px-2 py-0.5 rounded text-[11px] bg-slate-800 text-slate-300 hover:text-white"
                >
                  Mẫu Scraper
                </button>
                <button
                  type="button"
                  onClick={() => handleJsonChange(TELEGRAM_BOT_PRESET)}
                  className="px-2 py-0.5 rounded text-[11px] bg-slate-800 text-amber-300 hover:text-white hover:bg-slate-700"
                >
                  Mẫu Telegram Bot
                </button>
                <button
                  type="button"
                  onClick={handleFormatJson}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-slate-800 text-amber-300 hover:bg-slate-700"
                >
                  <Sparkles className="w-3 h-3" />
                  <span>Format</span>
                </button>
              </div>
            </div>

            <textarea
              rows={5}
              value={rawJson}
              onChange={(e) => handleJsonChange(e.target.value)}
              placeholder='{ "command": "/start", "collect": { "timeoutMs": 30000 } }'
              className={`w-full p-3 bg-slate-950 border rounded-xl text-xs text-slate-100 font-mono placeholder:text-slate-700 focus:outline-none transition-colors ${
                jsonError ? 'border-rose-500/80 focus:border-rose-500' : 'border-slate-800 focus:border-amber-500'
              }`}
              spellCheck={false}
            />

            <div className="flex items-center justify-between text-xs">
              {jsonError ? (
                <div className="flex items-center gap-1 text-rose-400">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{jsonError}</span>
                </div>
              ) : (
                <div className="flex items-center gap-1 text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Cú pháp JSON hợp lệ</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-800">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="w-4 h-4 rounded text-amber-500 bg-slate-950 border-slate-700 focus:ring-amber-500"
              />
              <span className="text-xs font-semibold text-slate-200">Hoạt động (Active)</span>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition-colors"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={submitting || Boolean(jsonError) || Boolean(botUsernameError)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-xs font-semibold text-slate-950 transition-colors disabled:opacity-50"
              >
                <Check className="w-4 h-4" />
                <span>{submitting ? 'Đang lưu...' : 'Lưu nhà cung cấp'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
