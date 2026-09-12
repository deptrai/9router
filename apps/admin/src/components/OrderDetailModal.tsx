'use client';

import React, { useState, useEffect } from 'react';
import {
  X,
  User,
  Package,
  Clock,
  RotateCcw,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  FileText,
  Copy,
  Check,
  Eye,
  EyeOff,
  Truck,
  DollarSign,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { AdminOrderDetailDto } from '@repo/shared-types';
import { apiClient } from '../lib/api-client';

interface OrderDetailModalProps {
  isOpen: boolean;
  orderId: string | null;
  onClose: () => void;
  onOrderRefunded: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
}

export function OrderDetailModal({
  isOpen,
  orderId,
  onClose,
  onOrderRefunded,
  showToast,
}: OrderDetailModalProps) {
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<AdminOrderDetailDto | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Decryption state
  const [revealing, setRevealing] = useState(false);
  const [decryptedKey, setDecryptedKey] = useState<string | null>(null);

  // Refund dialog state
  const [showRefundDialog, setShowRefundDialog] = useState(false);
  const [refundReason, setRefundReason] = useState('');
  const [markDefective, setMarkDefective] = useState(false);
  const [refunding, setRefunding] = useState(false);

  // Payload collapse state
  const [expandedPayloads, setExpandedPayloads] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (isOpen && orderId) {
      loadDetail();
    } else {
      setDetail(null);
      setDecryptedKey(null);
      setShowRefundDialog(false);
      setRefundReason('');
    }
  }, [isOpen, orderId]);

  const loadDetail = async () => {
    if (!orderId) return;
    setLoading(true);
    try {
      const res = await apiClient.get<{ ok: boolean; order: AdminOrderDetailDto }>(
        `/api/admin/orders/${orderId}`,
      );
      setDetail(res.order);
    } catch (err: any) {
      showToast(err?.message || 'Không thể tải chi tiết đơn hàng', 'error');
      onClose();
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async (text: string, field: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleRevealCredential = async () => {
    if (decryptedKey) {
      // Toggle off — hide plaintext and revert to masked display
      setDecryptedKey(null);
      return;
    }
    if (!detail?.order.id) return;
    setRevealing(true);
    try {
      // Call admin reveal endpoint — server logs [AUDIT] and returns plaintext
      const res = await apiClient.post<{ ok: boolean; plaintext: string }>(
        `/api/admin/orders/${detail.order.id}/reveal-credential`,
        {},
      );
      setDecryptedKey(res.plaintext);
    } catch (err: any) {
      showToast(err?.message || 'Không thể giải mã credential', 'error');
    } finally {
      setRevealing(false);
    }
  };

  const handleRefundSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orderId || !refundReason.trim()) return;

    setRefunding(true);
    try {
      const res = await apiClient.post<{ ok: boolean; refunded: boolean; refundedAmount: string }>(
        `/api/admin/orders/${orderId}/refund`,
        {
          reason: refundReason.trim(),
          markCredentialDefective: markDefective,
        },
      );

      showToast(`Đã hoàn tiền ${parseFloat(res.refundedAmount).toLocaleString('vi-VN')} ₫ vào ví khách hàng`, 'success');
      setShowRefundDialog(false);
      setRefundReason('');
      onOrderRefunded();
      loadDetail();
    } catch (err: any) {
      showToast(err?.message || 'Không thể hoàn tiền đơn hàng', 'error');
    } finally {
      setRefunding(false);
    }
  };

  if (!isOpen || !orderId) return null;

  const isRefundable =
    detail && ['PAID', 'SOURCING', 'FULFILLED'].includes(detail.order.status);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-100">Chi tiết Đơn hàng</h2>
                <span className="font-mono text-xs text-slate-500">#{orderId.slice(0, 8)}</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Toàn bộ lịch sử giao dịch, chuỗi cung ứng và tác vụ kiểm toán
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 text-xs">
          {loading ? (
            <div className="py-16 text-center text-slate-500">Đang tải thông tin đơn hàng...</div>
          ) : !detail ? (
            <div className="py-16 text-center text-rose-400">Không tìm thấy thông tin đơn hàng</div>
          ) : (
            <>
              {/* Order Status Banner */}
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-bold border ${
                      detail.order.status === 'FULFILLED'
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                        : detail.order.status === 'SOURCING'
                        ? 'bg-blue-500/10 text-blue-400 border-blue-500/20 animate-pulse'
                        : detail.order.status === 'REFUNDED'
                        ? 'bg-slate-800 text-slate-400 border-slate-700'
                        : detail.order.status === 'PAID'
                        ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                        : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                    }`}
                  >
                    {detail.order.status}
                  </span>
                  <div className="font-mono text-base font-bold text-slate-100">
                    {parseFloat(detail.order.price).toLocaleString('vi-VN')} ₫
                  </div>
                </div>

                {isRefundable && !showRefundDialog && (
                  <button
                    onClick={() => setShowRefundDialog(true)}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-400 font-bold transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Hoàn tiền thủ công</span>
                  </button>
                )}
              </div>

              {/* Refund Form Dialog */}
              {showRefundDialog && (
                <form
                  onSubmit={handleRefundSubmit}
                  className="p-4 rounded-xl bg-rose-950/20 border border-rose-500/30 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-rose-400 font-bold text-xs">
                      <AlertTriangle className="w-4 h-4" />
                      <span>Xác nhận hoàn tiền 100% về ví khách hàng</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowRefundDialog(false)}
                      className="text-slate-500 hover:text-slate-300"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <p className="text-[11px] text-slate-400">
                    Hệ thống sẽ cộng lại{' '}
                    <strong className="text-slate-200">
                      {parseFloat(detail.order.price).toLocaleString('vi-VN')} ₫
                    </strong>{' '}
                    vào ví của khách hàng và cập nhật trạng thái đơn thành <span className="text-slate-200">REFUNDED</span>.
                  </p>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                      Lý do hoàn tiền (Bắt buộc)
                    </label>
                    <textarea
                      required
                      value={refundReason}
                      onChange={(e) => setRefundReason(e.target.value)}
                      placeholder="Ví dụ: Khách hàng báo key không kích hoạt được, nhà cung cấp hết hàng..."
                      className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-rose-500/50 resize-none h-16"
                    />
                  </div>

                  {detail.product.sourcingMode === 'IN_HOUSE' && (
                    <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={markDefective}
                        onChange={(e) => setMarkDefective(e.target.checked)}
                        className="rounded bg-slate-950 border-slate-800 text-rose-500 focus:ring-0"
                      />
                      <span>Đánh dấu key trong kho nội bộ thành DEFECTIVE (Lỗi)</span>
                    </label>
                  )}

                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setShowRefundDialog(false)}
                      className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 bg-slate-800"
                    >
                      Hủy
                    </button>
                    <button
                      type="submit"
                      disabled={refunding || !refundReason.trim()}
                      className="px-4 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold transition-colors disabled:opacity-50"
                    >
                      {refunding ? 'Đang hoàn...' : 'Xác nhận hoàn tiền'}
                    </button>
                  </div>
                </form>
              )}

              {/* 2-Columns Info: Customer & Product */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Customer Info */}
                <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2.5">
                  <div className="flex items-center gap-2 font-bold text-slate-200 border-b border-slate-800/80 pb-2">
                    <User className="w-4 h-4 text-amber-400" />
                    <span>Khách hàng</span>
                  </div>
                  <div className="space-y-1.5 text-slate-400">
                    <div className="flex justify-between">
                      <span>Telegram ID:</span>
                      <span className="font-mono text-slate-200">{detail.customer.telegramId}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Username:</span>
                      <span className="text-slate-200">
                        {detail.customer.username ? `@${detail.customer.username}` : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Họ tên:</span>
                      <span className="text-slate-200">
                        {[detail.customer.firstName, detail.customer.lastName].filter(Boolean).join(' ') || '—'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Số dư ví hiện tại:</span>
                      <span className="font-mono text-emerald-400 font-semibold">
                        {parseFloat(detail.customer.walletBalance).toLocaleString('vi-VN')} ₫
                      </span>
                    </div>
                  </div>
                </div>

                {/* Product Info */}
                <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2.5">
                  <div className="flex items-center gap-2 font-bold text-slate-200 border-b border-slate-800/80 pb-2">
                    <Package className="w-4 h-4 text-amber-400" />
                    <span>Sản phẩm</span>
                  </div>
                  <div className="space-y-1.5 text-slate-400">
                    <div className="flex justify-between">
                      <span>Tên:</span>
                      <span className="font-semibold text-slate-200">{detail.product.title}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Nguồn hàng:</span>
                      <span
                        className={`px-2 py-0.2 rounded-full font-mono text-[10px] font-bold ${
                          detail.product.sourcingMode === 'IN_HOUSE'
                            ? 'bg-blue-500/10 text-blue-400'
                            : 'bg-purple-500/10 text-purple-400'
                        }`}
                      >
                        {detail.product.sourcingMode}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Danh mục:</span>
                      <span className="text-slate-200">{detail.product.category || 'Mặc định'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Ngày tạo đơn:</span>
                      <span className="font-mono text-slate-300">
                        {new Date(detail.order.createdAt).toLocaleString('vi-VN')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Delivered Credential Section */}
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-200">Credential đã giao</span>
                  {detail.order.deliveredCredential && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleRevealCredential}
                        disabled={revealing}
                        title={decryptedKey ? 'Ẩn plaintext' : 'Giải mã xem plaintext'}
                        className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-emerald-400 transition-colors disabled:opacity-50"
                      >
                        {decryptedKey ? (
                          <EyeOff className="w-3.5 h-3.5" />
                        ) : (
                          <Eye className="w-3.5 h-3.5" />
                        )}
                        <span>{revealing ? 'Đang giải mã...' : decryptedKey ? 'Ẩn' : 'Giải mã'}</span>
                      </button>
                      <button
                        onClick={() =>
                          handleCopy(
                            decryptedKey || detail.order.deliveredCredential || '',
                            'deliveredCredential',
                          )
                        }
                        className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-amber-400 transition-colors"
                      >
                        {copiedField === 'deliveredCredential' ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>{copiedField === 'deliveredCredential' ? 'Đã chép' : 'Sao chép'}</span>
                      </button>
                    </div>
                  )}
                </div>

                <div className="p-3 rounded-lg bg-slate-900 border border-slate-800/80 font-mono text-xs text-slate-300 break-all">
                  {decryptedKey ? (
                    <span className="text-emerald-400">{decryptedKey}</span>
                  ) : (
                    detail.order.deliveredCredential || (
                      <span className="text-slate-500 italic">Chưa giao credential hoặc đơn hàng chưa hoàn tất</span>
                    )
                  )}
                </div>
              </div>

              {/* Supplier Order Traces */}
              {detail.supplierTraces.length > 0 && (
                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                  <div className="flex items-center gap-2 font-bold text-slate-200">
                    <Truck className="w-4 h-4 text-purple-400" />
                    <span>Lịch sử đặt hàng Nhà cung cấp ngoài ({detail.supplierTraces.length})</span>
                  </div>

                  <div className="space-y-2.5">
                    {detail.supplierTraces.map((trace) => {
                      const isExpanded = expandedPayloads[trace.id];
                      return (
                        <div key={trace.id} className="p-3 rounded-lg bg-slate-900 border border-slate-800 space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-slate-200">
                                {trace.supplierName || 'Đối tác ngoài'}
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                  trace.status === 'SUCCESS'
                                    ? 'bg-emerald-500/10 text-emerald-400'
                                    : trace.status === 'PENDING'
                                    ? 'bg-blue-500/10 text-blue-400'
                                    : 'bg-rose-500/10 text-rose-400'
                                }`}
                              >
                                {trace.status}
                              </span>
                            </div>
                            <span className="text-[11px] text-slate-500 font-mono">
                              {new Date(trace.createdAt).toLocaleString('vi-VN')}
                            </span>
                          </div>

                          {trace.cost && (
                            <p className="text-slate-400">
                              Giá vốn đối tác: <strong className="text-slate-200">{parseFloat(trace.cost).toLocaleString('vi-VN')} ₫</strong>
                            </p>
                          )}

                          {trace.errorMessage && (
                            <p className="text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20 font-mono text-[11px]">
                              Lỗi: {trace.errorMessage}
                            </p>
                          )}

                          {Boolean(trace.rawPayload) && (
                            <div>
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedPayloads((prev) => ({
                                    ...prev,
                                    [trace.id]: !prev[trace.id],
                                  }))
                                }
                                className="flex items-center gap-1 text-[11px] text-amber-400 hover:text-amber-300 font-semibold"
                              >
                                {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                <span>{isExpanded ? 'Ẩn phản hồi JSON' : 'Xem phản hồi JSON'}</span>
                              </button>
                              {isExpanded && (
                                <pre className="mt-1.5 p-2 rounded bg-slate-950 border border-slate-800 text-[10px] font-mono text-slate-300 overflow-x-auto max-h-40">
                                  {JSON.stringify(trace.rawPayload, null, 2)}
                                </pre>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Ledger Transactions */}
              {detail.ledgerTransactions.length > 0 && (
                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5">
                  <div className="flex items-center gap-2 font-bold text-slate-200">
                    <DollarSign className="w-4 h-4 text-emerald-400" />
                    <span>Lịch sử biến động số dư Sổ cái ({detail.ledgerTransactions.length})</span>
                  </div>

                  <div className="divide-y divide-slate-800">
                    {detail.ledgerTransactions.map((tx) => (
                      <div key={tx.id} className="py-2 flex items-center justify-between text-[11px]">
                        <div>
                          <p className="font-semibold text-slate-200">{tx.type}</p>
                          <p className="text-[10px] text-slate-500 font-mono">
                            {new Date(tx.createdAt).toLocaleString('vi-VN')}
                          </p>
                        </div>
                        <div className="text-right font-mono">
                          <p
                            className={`font-bold ${
                              parseFloat(tx.amount) >= 0 ? 'text-emerald-400' : 'text-slate-300'
                            }`}
                          >
                            {parseFloat(tx.amount) >= 0 ? '+' : ''}
                            {parseFloat(tx.amount).toLocaleString('vi-VN')} ₫
                          </p>
                          <p className="text-[10px] text-slate-500">
                            Số dư sau: {parseFloat(tx.balanceAfter).toLocaleString('vi-VN')} ₫
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
