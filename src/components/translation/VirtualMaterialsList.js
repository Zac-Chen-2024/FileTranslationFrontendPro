import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { materialAPI } from '../../services/api';
import {
  ProcessingStep,
  getStatusDisplay,
  isProcessing,
  isCompleted,
  isConfirmable,
  isFailed,
  normalizeStatus
} from '../../constants/status';
import styles from './MaterialsList.module.css';

// 虚拟滚动配置
const ITEM_HEIGHT = 110; // 每个材料项的高度（考虑多行文字：padding 12px*2 + border 2px + 文件名最多3-4行 + 元信息20px + 间距）
const ITEM_GAP = 10; // 项目之间的间距
const BUFFER_SIZE = 5; // 缓冲区大小，提前渲染的项目数
const SCROLL_DEBOUNCE = 10; // 滚动防抖延迟

// 获取类型标签的辅助函数（现在接受t函数作为参数）
const getTypeLabel = (type, isPdfSession = false, t) => {
  if (isPdfSession) {
    return t('pdfDocument');
  }
  const typeLabels = {
    pdf: t('pdfDocument'),
    image: t('image'),
    webpage: t('webpage'),
    document: t('document')
  };
  return typeLabels[type] || type;
};

// 获取状态标签的辅助函数 - 支持ProcessingStep枚举值和旧的中文状态
const getStatusLabel = (status, t) => {
  const statusLabels = {
    // ProcessingStep 枚举值
    [ProcessingStep.UPLOADED]: t('uploaded'),
    [ProcessingStep.SPLITTING]: t('splitting') || '拆分中',
    [ProcessingStep.SPLIT_COMPLETED]: t('splitCompleted') || '拆分完成',
    [ProcessingStep.TRANSLATING]: t('statusTranslating'),
    [ProcessingStep.TRANSLATED]: t('translated'),
    [ProcessingStep.ENTITY_RECOGNIZING]: t('entityRecognizing') || '实体识别中',
    [ProcessingStep.ENTITY_PENDING_CONFIRM]: t('entityPendingConfirm') || '待确认实体',
    [ProcessingStep.ENTITY_CONFIRMED]: t('entityConfirmed') || '实体已确认',
    [ProcessingStep.LLM_TRANSLATING]: t('llmTranslating') || 'AI优化中',
    [ProcessingStep.LLM_TRANSLATED]: t('llmTranslated') || 'AI优化完成',
    [ProcessingStep.CONFIRMED]: t('confirmed'),
    [ProcessingStep.FAILED]: t('translationFailed'),
    // 旧的中文状态（向后兼容）
    '已添加': t('added'),
    '已上传': t('uploaded'),
    '处理中': t('processing'),
    '正在翻译': t('statusTranslating'),
    '翻译中': t('statusTranslating'),
    '翻译完成': t('translated'),
    '已翻译': t('translated'),
    '已确认': t('confirmed'),
    '翻译失败': t('translationFailed')
  };
  return statusLabels[status] || getStatusDisplay(status) || status;
};

// 单个材料项组件
const VirtualMaterialItem = React.memo(({
  material,
  isActive,
  isSelected,
  onSelect,
  onDelete,
  onCheckboxChange,
  style,
  t
}) => {
  const handleClick = useCallback(() => {
    onSelect(material);
  }, [material, onSelect]);

  const handleDelete = useCallback((e) => {
    e.stopPropagation();
    onDelete(material, e);
  }, [material, onDelete]);

  const handleCheckboxClick = useCallback((e) => {
    e.stopPropagation();
    onCheckboxChange(e, material.id);
  }, [material.id, onCheckboxChange]);

  return (
    <div
      style={style}
      className={`${styles.materialItem} ${styles.virtualItem} ${
        isActive ? styles.active : ''
      } ${material.confirmed ? styles.confirmed : ''} ${
        isSelected ? styles.selected : ''
      }`}
      onClick={handleClick}
    >
      <input
        type="checkbox"
        className={styles.materialCheckbox}
        checked={isSelected}
        onChange={handleCheckboxClick}
        onClick={(e) => e.stopPropagation()}
      />
      <div className={styles.materialContent}>
        <div className={styles.materialTop}>
          <div className={styles.materialName}>
            {material.name}
            {material.isPdfSession && material.pdfTotalPages && (
              <span className={styles.pdfPageCount}> ({material.pdfTotalPages}页)</span>
            )}
          </div>
        </div>
        <div className={styles.materialMeta}>
          <span className={styles.materialType}>{getTypeLabel(material.type, material.isPdfSession, t)}</span>
          <span className={styles.materialStatus}>{getStatusLabel(material.status, t)}</span>
        </div>
      </div>
      <button
        className={styles.deleteMaterialBtn}
        onClick={handleDelete}
        title={t('deleteMaterial')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          <path d="M10 11v6M14 11v6"/>
        </svg>
      </button>
      {material.confirmed && (
        <div className={styles.confirmedIcon}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
      )}
    </div>
  );
});


const VirtualMaterialsList = ({ onAddMaterial, onExport, clientName, onFilesDropped, collapsed = false, onToggleCollapse }) => {
  const { state, actions } = useApp();
  const { t } = useLanguage();
  const { materials, currentClient, currentMaterial } = state;

  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(400);
  const [selectedMaterials, setSelectedMaterials] = useState(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const scrollContainerRef = useRef(null);
  const scrollTimeoutRef = useRef(null);
  const dragCounter = useRef(0);
  const materialsSectionRef = useRef(null); // 外层容器ref，用于监听高度变化

  // 使用useMemo优化材料列表的计算 - 包含PDF合并逻辑
  const clientMaterials = useMemo(() => {
    const filtered = materials.filter(m => m.clientId === currentClient?.cid);

    // 先收集PDF会话
    const pdfSessions = new Map();
    const nonPdfMaterials = [];

    filtered.forEach(material => {
      if (material.pdfSessionId) {
        if (!pdfSessions.has(material.pdfSessionId)) {
          // 使用第一页作为代表,但修改名称去掉页码
          const baseName = material.name.replace(/ - 第\d+页$/, '');
          const sessionMaterial = {
            ...material,
            id: material.pdfSessionId, // 使用session ID作为唯一标识
            name: baseName,
            isPdfSession: true,
            pdfTotalPages: material.pdfTotalPages,
            // 收集该会话的所有页面
            pages: []
          };
          pdfSessions.set(material.pdfSessionId, sessionMaterial);
        }
        // 添加页面到会话
        pdfSessions.get(material.pdfSessionId).pages.push(material);
      } else {
        nonPdfMaterials.push(material);
      }
    });

    // 更新PDF会话的状态（基于所有页面的状态）
    pdfSessions.forEach(sessionMaterial => {
      const pages = sessionMaterial.pages;

      // 计算整体状态 - 使用状态机辅助函数
      const allTranslated = pages.every(p =>
        isCompleted(normalizeStatus(p.status)) || isConfirmable(normalizeStatus(p.status))
      );
      const anyProcessing = pages.some(p => isProcessing(normalizeStatus(p.status)));
      const anyFailed = pages.some(p => isFailed(normalizeStatus(p.status)));
      const allConfirmed = pages.every(p => p.confirmed);

      if (allConfirmed) {
        sessionMaterial.status = ProcessingStep.CONFIRMED;
        sessionMaterial.confirmed = true;
      } else if (allTranslated) {
        sessionMaterial.status = ProcessingStep.TRANSLATED;
        sessionMaterial.confirmed = false; // 明确设置为未确认
      } else if (anyProcessing) {
        sessionMaterial.status = ProcessingStep.TRANSLATING;
        sessionMaterial.confirmed = false;
      } else if (anyFailed) {
        sessionMaterial.status = ProcessingStep.FAILED;
        sessionMaterial.confirmed = false;
      } else {
        sessionMaterial.status = pages[0].status;
        sessionMaterial.confirmed = false;
      }

      // 对页面按页码排序
      pages.sort((a, b) => a.pdfPageNumber - b.pdfPageNumber);

      // 始终使用第一页（按页码顺序）
      const firstPage = pages[0];
      sessionMaterial.translatedImagePath = firstPage.translatedImagePath;
      sessionMaterial.currentPage = firstPage; // 保存第一页供点击时使用
    });

    // 合并PDF会话和普通材料
    const allMaterials = [...Array.from(pdfSessions.values()), ...nonPdfMaterials];

    // 对非PDF材料进行去重
    return allMaterials.reduce((unique, material) => {
      if (material.isPdfSession) {
        unique.push(material);
        return unique;
      }

      const existing = unique.find(m => !m.isPdfSession && m.name === material.name);
      if (!existing) {
        unique.push(material);
      } else {
        // 如果有同名材料，优先保留翻译完成的或更新时间更晚的 - 使用状态机辅助函数
        const isTranslatedStatus = (s) => isCompleted(normalizeStatus(s)) || isConfirmable(normalizeStatus(s));
        const shouldReplace =
          (isTranslatedStatus(material.status) && !isTranslatedStatus(existing.status)) ||
          (material.status === existing.status && new Date(material.updatedAt) > new Date(existing.updatedAt)) ||
          (material.translatedImagePath && !existing.translatedImagePath);

        if (shouldReplace) {
          const index = unique.indexOf(existing);
          unique[index] = material;
        }
      }
      return unique;
    }, []);
  }, [materials, currentClient?.cid]);

  // 计算虚拟滚动参数（包含间距）
  const itemWithGapHeight = ITEM_HEIGHT + ITEM_GAP;
  // 总高度 = 所有项目高度 + (项目数-1)个间距（最后一项不需要间距）
  const totalHeight = clientMaterials.length > 0
    ? (clientMaterials.length * ITEM_HEIGHT) + ((clientMaterials.length - 1) * ITEM_GAP)
    : 0;
  const startIndex = Math.max(0, Math.floor(scrollTop / itemWithGapHeight) - BUFFER_SIZE);
  const endIndex = Math.min(
    clientMaterials.length,
    Math.ceil((scrollTop + containerHeight) / itemWithGapHeight) + BUFFER_SIZE
  );
  const visibleItems = clientMaterials.slice(startIndex, endIndex);

  // 处理滚动事件
  const handleScroll = useCallback((e) => {
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    
    scrollTimeoutRef.current = setTimeout(() => {
      setScrollTop(e.target.scrollTop);
    }, SCROLL_DEBOUNCE);
  }, []);

  // 更新高度的核心函数（提取出来供其他地方调用）
  const updateContainerHeight = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    const outerContainer = materialsSectionRef.current;

    if (!scrollContainer || !outerContainer) return;

    const availableHeight = scrollContainer.clientHeight;

    setContainerHeight(availableHeight);
  }, [clientMaterials.length, totalHeight]);

  // 监听容器尺寸变化
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const outerContainer = materialsSectionRef.current;

    if (!scrollContainer || !outerContainer) return;

    // 初始化时设置高度
    updateContainerHeight();

    // 使用 ResizeObserver 监听容器的尺寸变化
    const resizeObserver = new ResizeObserver(() => {
      // 使用 requestAnimationFrame 确保布局完成
      requestAnimationFrame(() => {
        updateContainerHeight();
      });
    });

    // 监听外层容器
    resizeObserver.observe(outerContainer);
    // 同时监听内层滚动容器
    resizeObserver.observe(scrollContainer);

    // 同时监听 window resize
    window.addEventListener('resize', updateContainerHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateContainerHeight);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [updateContainerHeight]);

  // 当选择材料时，延迟更新高度（因为右边内容会变化）
  useEffect(() => {
    // 当材料变化时，右边内容会重新渲染，需要等待布局完成
    const timer = setTimeout(() => {
      updateContainerHeight();
    }, 100); // 给右边内容100ms渲染时间

    return () => clearTimeout(timer);
  }, [currentMaterial?.id, updateContainerHeight]);

  const handleMaterialSelect = useCallback((material) => {
    // 如果是PDF会话,选择第一页
    if (material.isPdfSession && material.currentPage) {
      actions.setCurrentMaterial(material.currentPage);
    } else {
      actions.setCurrentMaterial(material);
    }
  }, [actions]);

  const handleDeleteMaterial = useCallback(async (material, e) => {
    const deleteMessage = material.isPdfSession
      ? t('confirmDeletePdf', { name: material.name, pages: material.pdfTotalPages })
      : t('confirmDeleteMaterial', { name: material.name });

    actions.openConfirmDialog({
      title: t('deleteMaterial'),
      message: deleteMessage,
      type: 'danger',
      confirmText: t('delete'),
      cancelText: t('cancel'),
      onConfirm: async () => {
        try {
          if (material.isPdfSession) {
            // 删除PDF会话的所有页面
            const deletePromises = material.pages.map(page => materialAPI.deleteMaterial(page.id));
            await Promise.all(deletePromises);

            actions.showNotification(t('deleteSuccess'), t('pdfPagesDeleted', { name: material.name }), 'success');

            // 从本地状态中移除所有页面
            const pageIds = material.pages.map(p => p.id);
            const updatedMaterials = materials.filter(m => !pageIds.includes(m.id));
            actions.setMaterials(updatedMaterials);

            // 如果删除的页面中包含当前选中的材料，清除选择
            if (currentMaterial && pageIds.includes(currentMaterial.id)) {
              actions.setCurrentMaterial(null);
            }
          } else {
            // 删除单个材料
            await materialAPI.deleteMaterial(material.id);
            actions.showNotification(t('deleteSuccess'), t('materialDeleted', { name: material.name }), 'success');

            // 从本地状态中移除材料
            const updatedMaterials = materials.filter(m => m.id !== material.id);
            actions.setMaterials(updatedMaterials);

            // 如果删除的是当前选中的材料，清除选择
            if (currentMaterial?.id === material.id) {
              actions.setCurrentMaterial(null);
            }
          }
        } catch (error) {
          actions.showNotification(t('deleteFailed'), error.message || t('deleteError'), 'error');
        }
      }
    });
  }, [actions, materials, currentMaterial, t]);

  // 处理复选框变化
  const handleCheckboxChange = useCallback((e, materialId) => {
    setSelectedMaterials(prev => {
      const newSet = new Set(prev);
      if (newSet.has(materialId)) {
        newSet.delete(materialId);
      } else {
        newSet.add(materialId);
      }
      return newSet;
    });
  }, []);

  // 批量确认
  const handleBatchConfirm = useCallback(async () => {
    const selectedList = Array.from(selectedMaterials);

    // 判断是否可确认的状态 - 使用状态机辅助函数
    const canConfirmStatus = (status) => isConfirmable(normalizeStatus(status));

    // 展开PDF会话中的所有页面
    const materialsToConfirm = [];
    clientMaterials.forEach(m => {
      if (selectedList.includes(m.id)) {
        if (m.isPdfSession) {
          // 添加PDF会话的所有页面
          m.pages.forEach(page => {
            if (canConfirmStatus(page.status) && !page.confirmed) {
              materialsToConfirm.push(page);
            }
          });
        } else if (canConfirmStatus(m.status) && !m.confirmed) {
          materialsToConfirm.push(m);
        }
      }
    });

    const confirmableMaterials = materialsToConfirm;

    if (confirmableMaterials.length === 0) {
      actions.showNotification(t('hint'), t('noConfirmableMaterials'), 'warning');
      return;
    }

    actions.openConfirmDialog({
      title: t('batchConfirm'),
      message: t('confirmMultipleMaterials', { count: confirmableMaterials.length }),
      type: 'primary',
      confirmText: t('confirm'),
      cancelText: t('cancel'),
      onConfirm: async () => {
        try {
          // 批量确认API调用
          const promises = confirmableMaterials.map(material =>
            materialAPI.confirmMaterial(material.id)
          );

          await Promise.all(promises);

          // 更新本地状态
          confirmableMaterials.forEach(material => {
            actions.updateMaterial(material.id, {
              confirmed: true,
              status: getStatusDisplay(ProcessingStep.CONFIRMED)
            });
          });

          actions.showNotification(t('batchConfirmSuccess'), t('confirmedMultipleMaterials', { count: confirmableMaterials.length }), 'success');
          setSelectedMaterials(new Set());
        } catch (error) {
          actions.showNotification(t('batchConfirmFailed'), error.message || t('operationError'), 'error');
        }
      }
    });
  }, [selectedMaterials, clientMaterials, actions, t]);

  // 拖拽事件处理
  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (dragCounter.current === 1) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0 && onFilesDropped) {
      onFilesDropped(files);
    }
  }, [onFilesDropped]);

  // 批量删除
  const handleBatchDelete = useCallback(async () => {
    const selectedList = Array.from(selectedMaterials);
    if (selectedList.length === 0) {
      actions.showNotification(t('hint'), t('pleaseSelectMaterials'), 'warning');
      return;
    }

    // 展开PDF会话中的所有页面
    const idsToDelete = [];
    clientMaterials.forEach(m => {
      if (selectedList.includes(m.id)) {
        if (m.isPdfSession) {
          // 添加PDF会话的所有页面ID
          m.pages.forEach(page => idsToDelete.push(page.id));
        } else {
          idsToDelete.push(m.id);
        }
      }
    });

    actions.openConfirmDialog({
      title: t('batchDelete'),
      message: t('confirmDeleteMultiple', { count: selectedList.length }),
      type: 'danger',
      confirmText: t('delete'),
      cancelText: t('cancel'),
      onConfirm: async () => {
        try {
          // 批量删除API调用
          const promises = idsToDelete.map(id =>
            materialAPI.deleteMaterial(id)
          );

          await Promise.all(promises);

          // 更新本地状态
          const updatedMaterials = materials.filter(m => !idsToDelete.includes(m.id));
          actions.setMaterials(updatedMaterials);

          // 如果删除了当前选中的材料
          if (currentMaterial && idsToDelete.includes(currentMaterial.id)) {
            actions.setCurrentMaterial(null);
          }

          actions.showNotification(t('batchDeleteSuccess'), t('deletedMultipleItems', { count: selectedList.length }), 'success');
          setSelectedMaterials(new Set());
        } catch (error) {
          actions.showNotification(t('batchDeleteFailed'), error.message || t('operationError'), 'error');
        }
      }
    });
  }, [selectedMaterials, materials, currentMaterial, actions, clientMaterials, t]);

  if (clientMaterials.length === 0) {
    return (
      <div
        className={`${styles.materialsSection} ${isDragging ? styles.dragging : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div className={styles.header}>
          <h3 className={styles.title}>{t('materialListFor', { name: clientName })}</h3>
          <div className={styles.actions}>
            <button
              className={`${styles.actionBtn} ${styles.btnAdd}`}
              onClick={onAddMaterial}
            >
              {t('add')}
            </button>
            <button
              className={`${styles.actionBtn} ${styles.btnExport}`}
              onClick={onExport}
              disabled={true}
              title={t('noMaterialsToExport')}
            >
              {t('export')}
            </button>
          </div>
        </div>
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="18" x2="12" y2="12" />
              <line x1="9" y1="15" x2="15" y2="15" />
            </svg>
          </div>
          <h4 className={styles.emptyTitle}>{t('noMaterials')}</h4>
          <p className={styles.emptyDescription}>
            {t('addTranslationMaterials', { name: currentClient?.name })}
          </p>
        </div>

        {/* 拖拽悬浮提示 */}
        {isDragging && (
          <div className={styles.dragOverlay}>
            <div className={styles.dragOverlayContent}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <p>释放文件以上传</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // 收缩状态：只显示展开按钮
  if (collapsed) {
    return (
      <div className={styles.collapsedSidebar}>
        <button
          className={styles.expandButton}
          onClick={onToggleCollapse}
          title="展开材料列表"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div
      ref={materialsSectionRef}
      className={`${styles.materialsSection} ${isDragging ? styles.dragging : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className={styles.header}>
        <button
          className={styles.collapseButton}
          onClick={onToggleCollapse}
          title="收起材料列表"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
        </button>
        <h3 className={styles.title}>{t('materialListFor', { name: clientName })}</h3>
        <div className={styles.actions}>
          <button
            className={`${styles.actionBtn} ${styles.btnAdd}`}
            onClick={onAddMaterial}
          >
            {t('add')}
          </button>
          <button
            className={`${styles.actionBtn} ${styles.btnExport}`}
            onClick={onExport}
          >
            {t('export')}
          </button>
        </div>
      </div>

      {/* 批量操作栏 - 常驻 */}
      <div className={styles.batchActionsBar}>
        <div className={styles.batchActionsLeft}>
          <label className={styles.selectAllLabel}>
            <input
              type="checkbox"
              checked={selectedMaterials.size > 0 && selectedMaterials.size === clientMaterials.length}
              onChange={(e) => {
                if (e.target.checked) {
                  setSelectedMaterials(new Set(clientMaterials.map(m => m.id)));
                } else {
                  setSelectedMaterials(new Set());
                }
              }}
            />
            <span>{t('selectAll')}{selectedMaterials.size > 0 && `(${selectedMaterials.size})`}</span>
          </label>
        </div>
        <div className={styles.batchActionsRight}>
          <button
            className={`${styles.batchActionBtn} ${styles.batchConfirmBtn}`}
            onClick={handleBatchConfirm}
            disabled={selectedMaterials.size === 0}
          >
            {t('confirm')}
          </button>
          <button
            className={`${styles.batchActionBtn} ${styles.batchDeleteBtn}`}
            onClick={handleBatchDelete}
            disabled={selectedMaterials.size === 0}
          >
            {t('delete')}
          </button>
        </div>
      </div>
      
      <div
        ref={scrollContainerRef}
        className={styles.materialsList}
        onScroll={handleScroll}
        style={{
          position: 'relative',
          overflowY: 'auto'
        }}
      >
        {/* Virtual spacer to create scrollable height */}
        <div style={{
          height: totalHeight,
          position: 'relative',
          width: '100%'
        }}>
          {/* Render only visible items */}
          {visibleItems.map((material, index) => {
            // 判断是否为当前激活的材料
            // 对于PDF会话，需要检查currentMaterial是否是该会话的某一页
            const isActive = material.isPdfSession
              ? currentMaterial?.pdfSessionId === material.id
              : currentMaterial?.id === material.id;

            const actualIndex = startIndex + index;
            const top = actualIndex * itemWithGapHeight;

            return (
              <VirtualMaterialItem
                key={material.id}
                material={material}
                isActive={isActive}
                isSelected={selectedMaterials.has(material.id)}
                onSelect={handleMaterialSelect}
                onDelete={handleDeleteMaterial}
                onCheckboxChange={handleCheckboxChange}
                t={t}
                style={{
                  position: 'absolute',
                  top: top,
                  left: 0,
                  right: 0,
                  height: ITEM_HEIGHT
                }}
              />
            );
          })}
        </div>
      </div>

      {/* 拖拽悬浮提示 */}
      {isDragging && (
        <div className={styles.dragOverlay}>
          <div className={styles.dragOverlayContent}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <p>释放文件以上传</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default React.memo(VirtualMaterialsList, (prevProps, nextProps) => {
  return (
    prevProps.clientName === nextProps.clientName &&
    prevProps.onAddMaterial === nextProps.onAddMaterial &&
    prevProps.onExport === nextProps.onExport &&
    prevProps.onFilesDropped === nextProps.onFilesDropped &&
    prevProps.collapsed === nextProps.collapsed &&
    prevProps.onToggleCollapse === nextProps.onToggleCollapse
  );
});