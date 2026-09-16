import React, {useState, useRef, useCallback, useEffect, useMemo} from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faChevronRight, faExternalLinkAlt, faEye, faEyeSlash, faDownload, faChevronDown } from '@fortawesome/free-solid-svg-icons';
import './DictionaryCarousel.css';
import {fixupUrls} from "../utils/textUtils";

const HPA_IMAGES_BASE = 'https://images.proteinatlas.org/dictionary_images';

async function fetchDziDescriptor(fileupId) {
  try {
    const response = await fetch(`${HPA_IMAGES_BASE}/${fileupId}.dzi`);
    if (!response.ok) return null;

    const text = await response.text();
    const widthMatch = text.match(/Width="(\d+)"/i);
    const heightMatch = text.match(/Height="(\d+)"/i);
    const tileSizeMatch = text.match(/TileSize="(\d+)"/i);
    const overlapMatch = text.match(/Overlap="(\d+)"/i);
    const formatMatch = text.match(/Format="(\w+)"/i);

    if (widthMatch && heightMatch) {
      return {
        width: parseInt(widthMatch[1], 10),
        height: parseInt(heightMatch[1], 10),
        tileSize: tileSizeMatch ? parseInt(tileSizeMatch[1], 10) : 512,
        overlap: overlapMatch ? parseInt(overlapMatch[1], 10) : 1,
        format: formatMatch ? formatMatch[1] : 'jpg'
      };
    }
    return null;
  } catch {
    return null;
  }
}


async function probeMaxLevel(fileupId) {
  for (let level = 16; level >= 8; level--) {
    try {
      const response = await fetch(`${HPA_IMAGES_BASE}/${fileupId}_files/${level}/0_0.jpg`, { method: 'HEAD' });
      if (response.ok) return level;
    } catch {
      // continue
    }
  }
  return 15;
}

function getAnnotationList(annotations) {
  if (!annotations) return [];
  if (annotations.list) return annotations.list;
  if (Array.isArray(annotations)) return annotations;
  return [];
}


function TissueViewer({ imageId, annotations = [], hiddenAnnotations = new Set(), onViewerReady, onZoomChange }) {
  const annotationList = getAnnotationList(annotations);
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const overlaysRef = useRef(new Map());
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let mounted = true;
    const overlays = overlaysRef.current;

    if (!containerRef.current) return;

    const initViewer = async () => {
      if (!window.OpenSeadragon) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/openseadragon@4.1/build/openseadragon/openseadragon.min.js';
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }

      if (!mounted || !containerRef.current) return;

      const dzi = await fetchDziDescriptor(imageId);
      let imageConfig, tileSize = 512, tileOverlap = 1, tileFormat = 'jpg';

      if (dzi) {
        imageConfig = { width: dzi.width, height: dzi.height };
        tileSize = dzi.tileSize;
        tileOverlap = dzi.overlap;
        tileFormat = dzi.format;
      } else {
        const maxLevel = await probeMaxLevel(imageId);
        const size = Math.pow(2, maxLevel);
        imageConfig = { width: size, height: size };
      }

      const maxLevel = Math.ceil(Math.log2(Math.max(imageConfig.width, imageConfig.height)));
      let minLevel = 8;

      for (let level = 0; level <= 10; level++) {
        try {
          const resp = await fetch(`${HPA_IMAGES_BASE}/${imageId}_files/${level}/0_0.${tileFormat}`, { method: 'HEAD' });
          if (resp.ok) { minLevel = level; break; }
        } catch {}
      }

      const tileSource = {
        width: imageConfig.width,
        height: imageConfig.height,
        tileSize, tileOverlap, minLevel, maxLevel,
        getTileUrl: (level, x, y) => `${HPA_IMAGES_BASE}/${imageId}_files/${level}/${x}_${y}.${tileFormat}`
      };

      const viewer = window.OpenSeadragon({
        element: containerRef.current,
        tileSources: tileSource,
        showNavigator: true,
        navigatorPosition: 'BOTTOM_RIGHT',
        navigatorSizeRatio: 0.15,
        navigatorBackground: '#fff',
        navigatorBorderColor: '#ccc',
        showNavigationControl: false,
        animationTime: 0.3,
        constrainDuringPan: true,
        maxZoomPixelRatio: 2,
        minZoomImageRatio: 0.8,
        crossOriginPolicy: 'Anonymous',
      });

      viewer.addHandler('zoom', (e) => {
        onZoomChange?.(e.zoom);
      });

      viewer.addHandler('open', () => {
        if (!mounted) return;
        setStatus('ready');
        onViewerReady?.(viewer);

        const viewport = viewer.viewport;
        const startZoom = viewport.getHomeZoom() * 0.8;
        const targetZoom = viewport.getHomeZoom();
        viewport.zoomTo(startZoom, null, true); // instant
        setTimeout(() => {
          viewport.zoomTo(targetZoom, null, false); // animated
        }, 100);

        overlaysRef.current.clear();

        if (annotationList?.length > 0) {
          annotationList.forEach((ann) => {
            if (!ann.text || ann.text.length < 2) return;

            const shapesToDraw = ann.shapes || (ann.shape ? [ann.shape] : []);
            const annId = ann.id || ann.text;

            let labelX = ann.normX ?? 0;
            let labelY = ann.normY ?? 0;

            if (labelX === 0 && labelY === 0 && shapesToDraw.length > 0) {
              const firstShape = shapesToDraw[0];
              if (firstShape.type === 'circle') {
                labelX = firstShape.cx || 0;
                labelY = firstShape.cy || 0;
              } else if (firstShape.type === 'ellipse') {
                labelX = firstShape.cx || 0;
                labelY = firstShape.cy || 0;
              } else if (firstShape.type === 'rect') {
                labelX = firstShape.x || 0;
                labelY = firstShape.y || 0;
              } else if (firstShape.type === 'path' && firstShape.d) {
                const match = firstShape.d.match(/M\s*([\d.]+)[,\s]+([\d.]+)/i);
                if (match) {
                  labelX = parseFloat(match[1]) || 0;
                  labelY = parseFloat(match[2]) || 0;
                }
              } else if (firstShape.type === 'line') {
                labelX = firstShape.x1 || 0;
                labelY = firstShape.y1 || 0;
              }
            }

            // Debug: log annotation processing
            const hasArrowShape = shapesToDraw.some(s => s.hasArrow);
            console.log('[Annotation]', ann.text, 'labelX:', labelX, 'labelY:', labelY, 'shapes:', shapesToDraw.length, 'hasArrow:', hasArrowShape);

            if (labelX === 0 && labelY === 0) {
              console.log('[Annotation] SKIPPED (0,0):', ann.text);
              return;
            }
            if (labelX < 0 || labelX > 1 || labelY < 0 || labelY > 1) {
              console.log('[Annotation] SKIPPED (out of bounds):', ann.text, labelX, labelY);
              return;
            }

            const txtBoxRect = shapesToDraw.find(s => s.type === 'rect' && s.isTxtBox);
            const visibleRect = shapesToDraw.find(s => s.type === 'rect' && !s.isTxtBox);
            const ellipseShape = shapesToDraw.find(s => s.type === 'ellipse');
            const circleShape = shapesToDraw.find(s => s.type === 'circle');

            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 1 1');
            svg.setAttribute('preserveAspectRatio', 'none');
            svg.style.cssText = 'width: 100%; height: 100%; overflow: visible; pointer-events: none;';
            svg.dataset.annId = annId;

            const baseStrokeWidth = 1.5;

            const setStroke = (el, stroke) => {
              el.setAttribute('stroke', stroke || '#000');
              el.setAttribute('stroke-width', String(baseStrokeWidth));
              el.setAttribute('vector-effect', 'non-scaling-stroke');
            };

            const addCap = (x, y, stroke, isVertical = false) => {
              const cap = document.createElementNS('http://www.w3.org/2000/svg', 'line');
              const offset = 0.004;
              if (isVertical) {
                cap.setAttribute('x1', String(x));
                cap.setAttribute('y1', String(y - offset));
                cap.setAttribute('x2', String(x));
                cap.setAttribute('y2', String(y + offset));
              } else {
                cap.setAttribute('x1', String(x - offset));
                cap.setAttribute('y1', String(y));
                cap.setAttribute('x2', String(x + offset));
                cap.setAttribute('y2', String(y));
              }
              setStroke(cap, stroke);
              svg.appendChild(cap);
            };

            shapesToDraw.forEach((shape, shapeIdx) => {
              console.log('[Shape]', ann.text, 'shape', shapeIdx, ':', shape.type, shape);
              if (shape.type === 'circle') {
                const circleEl = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circleEl.setAttribute('cx', String(shape.cx || 0));
                circleEl.setAttribute('cy', String(shape.cy || 0));
                circleEl.setAttribute('r', String(shape.r > 0 ? shape.r : 0.015));
                circleEl.setAttribute('fill', shape.fill || 'none');
                setStroke(circleEl, shape.stroke);
                svg.appendChild(circleEl);
              } else if (shape.type === 'ellipse') {
                const ellipseEl = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
                ellipseEl.setAttribute('cx', String(shape.cx || 0));
                ellipseEl.setAttribute('cy', String(shape.cy || 0));
                ellipseEl.setAttribute('rx', String(shape.rx || 0.01));
                ellipseEl.setAttribute('ry', String(shape.ry || 0.01));
                ellipseEl.setAttribute('fill', shape.fill || 'none');
                setStroke(ellipseEl, shape.stroke);
                svg.appendChild(ellipseEl);
              } else if (shape.type === 'rect' && !shape.isTxtBox) {
                const rectEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rectEl.setAttribute('x', String(shape.x || 0));
                rectEl.setAttribute('y', String(shape.y || 0));
                rectEl.setAttribute('width', String(shape.width || 0.01));
                rectEl.setAttribute('height', String(shape.height || 0.01));
                rectEl.setAttribute('fill', shape.fill || 'none');
                setStroke(rectEl, shape.stroke);
                svg.appendChild(rectEl);
              } else if (shape.type === 'path' && shape.d) {
                const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                pathEl.setAttribute('d', shape.d);
                pathEl.setAttribute('fill', shape.fill || 'none');
                setStroke(pathEl, shape.stroke);
                svg.appendChild(pathEl);

                if (shape.hasArrow) {
                  // Draw filled triangle arrowhead at START of path
                  const coords = shape.d.match(/[\d.]+/g)?.map(parseFloat) || [];
                  if (coords.length >= 4) {
                    const xs = coords.filter((_, i) => i % 2 === 0);
                    const ys = coords.filter((_, i) => i % 2 === 1);
                    // Arrow at start, pointing toward start
                    const x1 = xs[0], y1 = ys[0];
                    const x2 = xs[xs.length - 1], y2 = ys[ys.length - 1];
                    const dx = x1 - x2, dy = y1 - y2; // Direction toward start
                    const lineLen = Math.sqrt(dx * dx + dy * dy) || 0.01;
                    const ux = dx / lineLen, uy = dy / lineLen;
                    // Arrow size = 8% of line length, capped
                    const arrowLen = Math.min(lineLen * 0.12, 0.002);
                    const arrowWidth = arrowLen * 0.5;
                    const tipX = x1, tipY = y1;
                    const baseX = x1 - ux * arrowLen, baseY = y1 - uy * arrowLen;
                    const p1x = baseX - uy * arrowWidth, p1y = baseY + ux * arrowWidth;
                    const p2x = baseX + uy * arrowWidth, p2y = baseY - ux * arrowWidth;
                    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                    arrow.setAttribute('points', `${tipX},${tipY} ${p1x},${p1y} ${p2x},${p2y}`);
                    arrow.setAttribute('fill', shape.stroke || '#000');
                    arrow.setAttribute('stroke', 'none');
                    svg.appendChild(arrow);
                  }
                } else {
                  const coords = shape.d.match(/[\d.]+/g)?.map(parseFloat) || [];
                  if (coords.length >= 4) {
                    const xs = coords.filter((_, i) => i % 2 === 0);
                    const ys = coords.filter((_, i) => i % 2 === 1);
                    const x1 = xs[0], y1 = ys[0];
                    const x2 = xs[xs.length - 1], y2 = ys[ys.length - 1];
                    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
                    const isVertical = dy > dx;
                    addCap(x1, y1, shape.stroke, !isVertical);
                    addCap(x2, y2, shape.stroke, !isVertical);
                  }
                }
              } else if (shape.type === 'line') {
                const x1 = shape.x1 || 0, y1 = shape.y1 || 0;
                const x2 = shape.x2 || 0, y2 = shape.y2 || 0;
                const lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                lineEl.setAttribute('x1', String(x1));
                lineEl.setAttribute('y1', String(y1));
                lineEl.setAttribute('x2', String(x2));
                lineEl.setAttribute('y2', String(y2));
                setStroke(lineEl, shape.stroke);
                svg.appendChild(lineEl);

                if (shape.hasArrow) {
                  // Draw filled triangle arrowhead at START of line
                  const dx = x1 - x2, dy = y1 - y2; // Direction toward start
                  const lineLen = Math.sqrt(dx * dx + dy * dy) || 0.01;
                  const ux = dx / lineLen, uy = dy / lineLen;
                  // Arrow size = 8% of line length, capped
                  const arrowLen = Math.min(lineLen * 0.08, 0.002);
                  const arrowWidth = arrowLen * 0.5;
                  const tipX = x1, tipY = y1;
                  const baseX = x1 - ux * arrowLen, baseY = y1 - uy * arrowLen;
                  const p1x = baseX - uy * arrowWidth, p1y = baseY + ux * arrowWidth;
                  const p2x = baseX + uy * arrowWidth, p2y = baseY - ux * arrowWidth;
                  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                  arrow.setAttribute('points', `${tipX},${tipY} ${p1x},${p1y} ${p2x},${p2y}`);
                  arrow.setAttribute('fill', shape.stroke || '#000');
                  arrow.setAttribute('stroke', 'none');
                  svg.appendChild(arrow);
                } else {
                  const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
                  const isVertical = dy > dx;
                  addCap(x1, y1, shape.stroke, !isVertical);
                  addCap(x2, y2, shape.stroke, !isVertical);
                }
              }
            });

            // Create label container
            const labelContainer = document.createElement('div');
            labelContainer.className = 'HPAG-annotation-container';
            labelContainer.style.cssText = 'position: relative; pointer-events: none;';
            labelContainer.dataset.annId = annId;

            const label = document.createElement('span');
            label.textContent = ann.text;
            label.style.cssText = `
              display: inline-block;
              background: rgba(0,0,0,0.75);
              color: #fff;
              padding: 3px 8px;
              border-radius: 3px;
              font-size: 11px;
              font-weight: 500;
              white-space: nowrap;
              text-shadow: none;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            `;
            labelContainer.appendChild(label);

            let finalLabelX = labelX;
            let finalLabelY = labelY;
            let placement = window.OpenSeadragon.Placement.TOP_LEFT;

            // Check if this is an arrow annotation (has arrow shape)
            const isArrowAnnotation = hasArrowShape;
            const arrowLine = shapesToDraw.find(s => s.type === 'line' && s.hasArrow);
            const arrowPath = shapesToDraw.find(s => s.type === 'path' && s.hasArrow);

            // For arrows: put label at x2,y2 (opposite the arrowhead at x1,y1)
            if (isArrowAnnotation && arrowLine) {
              // Arrowhead is at x1,y1, so label goes at x2,y2
              finalLabelX = arrowLine.x2;
              finalLabelY = arrowLine.y2;
              // Determine placement based on arrow direction (from tail to head)
              const dx = arrowLine.x1 - arrowLine.x2; // direction from label to arrowhead
              const dy = arrowLine.y1 - arrowLine.y2;
              if (Math.abs(dx) > Math.abs(dy)) {
                placement = dx > 0 ? window.OpenSeadragon.Placement.LEFT : window.OpenSeadragon.Placement.RIGHT;
              } else {
                placement = dy > 0 ? window.OpenSeadragon.Placement.TOP : window.OpenSeadragon.Placement.BOTTOM;
              }
            } else if (isArrowAnnotation && arrowPath && arrowPath.d) {
              // Arrow is a path - extract start and end points from d attribute
              const pathMatch = arrowPath.d.match(/M\s*([\d.]+)[,\s]+([\d.]+).*?L\s*([\d.]+)[,\s]+([\d.]+)/i);
              if (pathMatch) {
                const [, px1, py1, px2, py2] = pathMatch.map(parseFloat);
                // Arrowhead at M point (px1,py1), label at L point (px2,py2)
                finalLabelX = px2;
                finalLabelY = py2;
                const dx = px1 - px2;
                const dy = py1 - py2;
                if (Math.abs(dx) > Math.abs(dy)) {
                  placement = dx > 0 ? window.OpenSeadragon.Placement.LEFT : window.OpenSeadragon.Placement.RIGHT;
                } else {
                  placement = dy > 0 ? window.OpenSeadragon.Placement.TOP : window.OpenSeadragon.Placement.BOTTOM;
                }
              } else {
                console.log('[Arrow] Could not parse path d:', arrowPath.d);
              }
            } else if (isArrowAnnotation) {
              console.log('[Arrow] No line/path found, using normX/normY:', finalLabelX, finalLabelY);
            } else if (circleShape && circleShape.cx > 0) {
              finalLabelX = circleShape.cx;
              finalLabelY = circleShape.cy + (circleShape.r || 0.015) - 0.0001;
              placement = window.OpenSeadragon.Placement.TOP;
            } else if (ellipseShape && ellipseShape.cx > 0) {
              finalLabelX = ellipseShape.cx;
              finalLabelY = ellipseShape.cy + (ellipseShape.ry || 0.01) - 0.00001;
              placement = window.OpenSeadragon.Placement.TOP;
            } else if (visibleRect && visibleRect.x > 0) {
              finalLabelX = visibleRect.x + (visibleRect.width || 0) / 2;
              finalLabelY = visibleRect.y + (visibleRect.height || 0) - 0.0001;
              placement = window.OpenSeadragon.Placement.TOP;
            } else if (txtBoxRect && txtBoxRect.x > 0 && txtBoxRect.y > 0) {
              finalLabelX = txtBoxRect.x + (txtBoxRect.width || 0) / 2;
              finalLabelY = txtBoxRect.y + (txtBoxRect.height || 0) / 2;
              placement = window.OpenSeadragon.Placement.CENTER;
            }

            // Only add overlays if there are shapes
            const hasSvg = svg.children.length > 0;
            console.log('[Annotation] SVG children:', svg.children.length, 'for:', ann.text, 'hasSvg:', hasSvg);
            if (hasSvg) {
              console.log('[Annotation] Adding overlays for:', ann.text, 'at', finalLabelX, finalLabelY);
              // Add SVG overlay
              viewer.addOverlay({
                element: svg,
                location: new window.OpenSeadragon.Rect(0, 0, 1, 1),
              });

              // Add label overlay
              viewer.addOverlay({
                element: labelContainer,
                location: new window.OpenSeadragon.Point(finalLabelX, finalLabelY),
                placement: placement,
              });

              // Store for eye toggle
              overlaysRef.current.set(annId, { svg, label: labelContainer });
            }
          });
        }
      });

      viewerRef.current = viewer;
    };

    const timer = setTimeout(() => {
      initViewer().catch(console.error);
    }, 50);

    return () => {
      clearTimeout(timer);
      mounted = false;
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
      overlays.clear();
    };
  }, [imageId, annotationList, onViewerReady, onZoomChange]);

  useEffect(() => {
    overlaysRef.current.forEach(({ svg, label }, annId) => {
      const isHidden = hiddenAnnotations.has(annId);
      if (svg) svg.style.opacity = isHidden ? '0' : '1';
      if (label) label.style.opacity = isHidden ? '0' : '1';
    });
  }, [hiddenAnnotations]);

  return (
    <div className="HPAG-dict-viewer-container">
      <div ref={containerRef} className="HPAG-dict-viewer-canvas" />
      {status === 'loading' && (
        <div className="HPAG-dict-viewer-loading">
          <div className="HPAG-dict-spinner" />
          <span>Loading...</span>
        </div>
      )}
    </div>
  );
}

/**
 * Recursive annotation tree item component
 */
function AnnotationTreeItem({ annotation, depth = 0, expanded, onToggleExpand, onToggleVisibility, onNavigate, hiddenAnnotations }) {
  const annId = annotation.id || annotation.text;
  const isHidden = hiddenAnnotations.has(annId);
  const hasChildren = annotation.children && annotation.children.length > 0;
  const isExpanded = expanded.has(annId);

  const handleRowClick = useCallback((e) => {
    // Only handle clicks on the row itself or text, not on buttons
    if (e.target.closest('.HPAG-dict-visibility-toggle') || e.target.closest('.HPAG-dict-expand-icon')) {
      return;
    }
    e.stopPropagation();
    if (hasChildren) {
      onToggleExpand(annId);
    }
    // Only navigate if this annotation has shapes (not a section header)
    if (annotation.shapes && annotation.shapes.length > 0) {
      onNavigate(annotation);
    }
  }, [hasChildren, annId, annotation, onToggleExpand, onNavigate]);

  const handleExpandClick = useCallback((e) => {
    e.stopPropagation();
    onToggleExpand(annId);
  }, [annId, onToggleExpand]);

  const handleVisibilityClick = useCallback((e) => {
    e.stopPropagation();
    onToggleVisibility(annId);
  }, [annId, onToggleVisibility]);

  return (
    <div className="HPAG-dict-annotation-section">
      <div
        className={`HPAG-dict-annotation-item ${depth === 0 ? 'HPAG-dict-section-header' : ''} ${isHidden ? 'HPAG-dict-hidden' : ''}`}
        style={{ paddingLeft: `${7 + depth * 16}px`, cursor: 'pointer' }}
        onClick={handleRowClick}
      >
        {hasChildren && (
          <span
            className={`HPAG-dict-expand-icon ${isExpanded ? 'expanded' : ''}`}
            onClick={handleExpandClick}
          >
            <FontAwesomeIcon icon={faChevronRight} />
          </span>
        )}
        {!hasChildren && <span className="HPAG-dict-expand-spacer" />}
        <span
          className="HPAG-dict-visibility-toggle"
          onClick={handleVisibilityClick}
          title={isHidden ? 'Show annotation' : 'Hide annotation'}
        >
          <FontAwesomeIcon icon={isHidden ? faEyeSlash : faEye} />
        </span>
        <span className="HPAG-dict-annotation-text">{annotation.text}</span>
      </div>
      {hasChildren && isExpanded && (
        <div className="HPAG-dict-annotation-children">
          {annotation.children.map((child, i) => (
            <AnnotationTreeItem
              key={child.id || i}
              annotation={child}
              depth={depth + 1}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onToggleVisibility={onToggleVisibility}
              onNavigate={onNavigate}
              hiddenAnnotations={hiddenAnnotations}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Dictionary Image Carousel with Annotation Sidebar
 */
export default function DictionaryCarousel({ dictionaryImages }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [expandedSections, setExpandedSections] = useState(new Set());
  const [hiddenAnnotations, setHiddenAnnotations] = useState(new Set());
  const [currentZoom, setCurrentZoom] = useState(1);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const viewerRef = useRef(null);
  const dropdownRef = useRef(null);

  const images = dictionaryImages?.images || [];
  const currentImage = images[currentIndex];
  dictionaryImages.dictionary_url = fixupUrls(dictionaryImages.dictionary_url);

  const goToPrevious = () => setCurrentIndex(prev => (prev > 0 ? prev - 1 : images.length - 1));
  const goToNext = () => setCurrentIndex(prev => (prev < images.length - 1 ? prev + 1 : 0));

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [dropdownOpen]);

  // Export current view as PNG
  const handleExportPNG = useCallback(() => {
    if (!viewerRef.current) return;
    const viewer = viewerRef.current;

    // Get the canvas from OpenSeadragon
    const canvas = viewer.drawer.canvas;
    if (!canvas) return;

    // Create a new canvas that includes overlays
    const container = viewer.container;
    const exportCanvas = document.createElement('canvas');
    const ctx = exportCanvas.getContext('2d');

    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;

    // Draw the base image
    ctx.drawImage(canvas, 0, 0);

    // Try to capture SVG overlays
    const svgOverlays = container.querySelectorAll('svg[data-ann-id]');
    svgOverlays.forEach(svg => {
      if (svg.style.opacity === '0') return; // Skip hidden
    });

    // Trigger download
    const link = document.createElement('a');
    const label = currentImage?.label?.replace(/[^a-z0-9]/gi, '_') || 'tissue_image';
    link.download = `HPA_${label}_${Date.now()}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  }, [currentImage?.label]);

  // Calculate center coordinates from annotation
  const getAnnotationCenter = useCallback((annotation) => {
    let centerX = annotation.normX ?? 0;
    let centerY = annotation.normY ?? 0;

    const shapes = annotation.shapes || (annotation.shape ? [annotation.shape] : []);
    if (shapes.length > 0) {
      const shape = shapes[0];
      if (shape.type === 'circle' && shape.cx > 0) {
        centerX = shape.cx;
        centerY = shape.cy;
      } else if (shape.type === 'ellipse' && shape.cx > 0) {
        centerX = shape.cx;
        centerY = shape.cy;
      } else if (shape.type === 'rect' && shape.x > 0) {
        centerX = shape.x + (shape.width || 0) / 2;
        centerY = shape.y + (shape.height || 0) / 2;
      } else if (shape.type === 'path' && shape.d) {
        const coords = shape.d.match(/[\d.]+/g)?.map(parseFloat) || [];
        if (coords.length >= 4) {
          const xs = coords.filter((_, i) => i % 2 === 0);
          const ys = coords.filter((_, i) => i % 2 === 1);
          centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
          centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
        }
      } else if (shape.type === 'line') {
        centerX = ((shape.x1 || 0) + (shape.x2 || 0)) / 2;
        centerY = ((shape.y1 || 0) + (shape.y2 || 0)) / 2;
      }
    }
    return { centerX, centerY };
  }, []);

  const handleAnnotationClick = useCallback((annotation) => {
    if (!viewerRef.current) return;
    const viewer = viewerRef.current;

    const { centerX, centerY } = getAnnotationCenter(annotation);

    if (centerX === 0 && centerY === 0) return;
    if (centerX < 0 || centerX > 1 || centerY < 0 || centerY > 1) return;

    viewer.viewport.panTo(new window.OpenSeadragon.Point(centerX, centerY));
    viewer.viewport.zoomTo(Math.min(viewer.viewport.getMaxZoom(), 4));
  }, [getAnnotationCenter]);

  const toggleSection = useCallback((id) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleVisibility = useCallback((id) => {
    setHiddenAnnotations(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // Normalize annotations - handle both old array format and new object format
  const normalizeAnnotations = useCallback((annotations) => {
    if (!annotations) return { list: [], tree: [] };

    if (annotations.list && annotations.tree) {
      return annotations;
    }

    if (Array.isArray(annotations)) {
      const list = annotations;
      const tree = annotations._tree || annotations.filter(a => a.depth === 0 || !a.parentId);
      return { list, tree };
    }

    return { list: [], tree: [] };
  }, []);

  const buildTree = useCallback((annotations) => {
    if (annotations === null) {
      return [];
    }
    const { tree, list } = normalizeAnnotations(annotations);

    // If we have a tree, use it
    if (tree && tree.length > 0) {
      return tree;
    }

    // Fallback: build from flat list using isSection/hasChildren
    if (list && list.length > 0) {
      const sections = [];
      let current = null;
      list.forEach(ann => {
        if (ann.isSection || ann.hasChildren) {
          current = { ...ann, children: ann.children || [] };
          sections.push(current);
        } else if (current) {
          current.children.push({ ...ann, children: [] });
        } else {
          sections.push({ ...ann, children: [] });
        }
      });
      return sections;
    }

    return [];
  }, [normalizeAnnotations]);

  const annotationTree = useMemo(
    () => buildTree(currentImage?.annotations ?? null),
    [currentImage?.annotations, buildTree]
  );

  useEffect(() => {
    if (currentImage?.annotations) {
      console.log('[DictionaryCarousel] Raw annotations:', currentImage.annotations);
      console.log('[DictionaryCarousel] Tree:', annotationTree);
      annotationTree.forEach(item => {
        console.log('[Tree item]', item.text, 'children:', item.children?.length || 0, 'hasShapes:', !!item.shapes?.length);
      });
    }
  }, [currentImage?.annotations, annotationTree]);

  const handleViewerReady = useCallback((v) => { viewerRef.current = v; }, []);
  const handleZoomChange = useCallback((zoom) => { setCurrentZoom(zoom); }, []);

  const annotationKey = `${currentIndex}-${annotationTree.length}`;
  useEffect(() => {
    console.log('[DictionaryCarousel] Image switch effect triggered, currentIndex:', currentIndex, 'annotationKey:', annotationKey);
    console.log('[DictionaryCarousel] currentImage:', currentImage?.label, 'id:', currentImage?.id, 'canRender:', currentImage?.canRender);
    console.log('[DictionaryCarousel] annotationTree length:', annotationTree.length);

    // Reset hidden annotations for the new image
    setHiddenAnnotations(new Set());

    // Expand all top-level sections by default
    if (annotationTree.length > 0) {
      const topIds = annotationTree.map(a => a.id || a.text);
      console.log('[DictionaryCarousel] Setting expandedSections to:', topIds);
      setExpandedSections(new Set(topIds));
    } else {
      console.log('[DictionaryCarousel] No annotations, clearing expandedSections');
      setExpandedSections(new Set());
    }
  }, [annotationKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!images.length) return null;

  return (
    <div className="HPAG-dict-carousel">
      {/* Header */}
      <div className="HPAG-dict-carousel-header">

        {/* Image selector dropdown */}
        <div className="HPAG-dict-image-selector" ref={dropdownRef}>
          <button
            className="HPAG-dict-selector-btn"
            onClick={() => images.length > 1 && setDropdownOpen(!dropdownOpen)}
            style={{ cursor: images.length > 1 ? 'pointer' : 'default' }}
          >
            <span className="HPAG-dict-selector-label">{currentImage?.label || 'Select Image'}</span>
            {images.length > 1 && (
              <>
                <span className="HPAG-dict-selector-count">{currentIndex + 1}/{images.length}</span>
                <FontAwesomeIcon icon={faChevronDown} className={`HPAG-dict-selector-arrow ${dropdownOpen ? 'open' : ''}`} />
              </>
            )}
          </button>
          {dropdownOpen && images.length > 1 && (
            <div className="HPAG-dict-selector-dropdown">
              {images.map((img, idx) => (
                <button
                  key={img.id || idx}
                  className={`HPAG-dict-selector-option ${idx === currentIndex ? 'active' : ''} ${img.canRender === false ? 'not-renderable' : ''}`}
                  onClick={() => {
                    setCurrentIndex(idx);
                    setDropdownOpen(false);
                  }}
                >
                  {img.label}
                  {img.isMultiplex && <span className="HPAG-dict-multiplex-badge-sm">MPX</span>}
                  {!img.isMultiplex && img.canRender === false && <span className="HPAG-dict-unavailable-badge">N/A</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="HPAG-dict-header-actions">
          <div className="HPAG-dict-export-btn" onClick={handleExportPNG} title="Export current view as PNG">
            <span>Export PNG</span>
                        <FontAwesomeIcon icon={faDownload} />

          </div>
          <a href={dictionaryImages.dictionary_url} target="_blank" rel="noopener noreferrer" className="HPAG-dict-carousel-link">
            View on HPA <FontAwesomeIcon icon={faExternalLinkAlt} />
          </a>
        </div>
      </div>

      {/* Main */}
      <div className="HPAG-dict-carousel-content">
        {/* Viewer */}
        <div className="HPAG-dict-carousel-viewer">
          {images.length > 1 && (
            <button className="HPAG-dict-nav-btn HPAG-dict-nav-prev" onClick={goToPrevious}>
              <FontAwesomeIcon icon={faChevronLeft} />
            </button>
          )}

          <div className="HPAG-dict-carousel-image-wrapper">
            {currentImage.canRender !== false && currentImage.id ? (
              <TissueViewer
                key={currentImage.id}
                imageId={currentImage.id}
                annotations={currentImage.annotations}
                hiddenAnnotations={hiddenAnnotations}
                onViewerReady={handleViewerReady}
                onZoomChange={handleZoomChange}
              />
            ) : (
              <div className="HPAG-dict-not-renderable">

                <div className="HPAG-dict-not-renderable-title">
                  {currentImage.isMultiplex ? 'Multiplex Image' : 'Image Unavailable'}
                </div>
                <div className="HPAG-dict-not-renderable-desc">
                  {currentImage.isMultiplex
                    ? 'This multiplex image requires the HPA viewer to display properly.'
                    : 'This image could not be loaded in the tile viewer.'}
                </div>
                <a
                  href={dictionaryImages.dictionary_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="HPAG-dict-view-on-hpa-btn"
                >
                  View on HPA <FontAwesomeIcon icon={faExternalLinkAlt} />
                </a>
              </div>
            )}
            {images.length > 1 && (
              <div className="HPAG-dict-carousel-counter">{currentIndex + 1} / {images.length}</div>
            )}
          </div>

          {images.length > 1 && (
            <button className="HPAG-dict-nav-btn HPAG-dict-nav-next" onClick={goToNext}>
              <FontAwesomeIcon icon={faChevronRight} />
            </button>
          )}
        </div>

        {/* Sidebar */}
        {console.log('[DictionaryCarousel] Rendering sidebar, key:', currentImage?.id || currentIndex, 'annotationTree:', annotationTree.length, 'expandedSections:', expandedSections.size)}
        <div className="HPAG-dict-sidebar">
          <div className="HPAG-dict-sidebar-header">
            <span>Structures</span>
            <span className="HPAG-dict-zoom-indicator">Zoom: {currentZoom.toFixed(1)}x</span>
          </div>
          <div className="HPAG-dict-sidebar-list" key={currentImage?.id || currentIndex}>
            {annotationTree.length > 0 ? (
              annotationTree.map((section, idx) => (
                <AnnotationTreeItem
                  key={`${currentImage?.id || currentIndex}-${section.id || idx}`}
                  annotation={section}
                  depth={0}
                  expanded={expandedSections}
                  onToggleExpand={toggleSection}
                  onToggleVisibility={toggleVisibility}
                  onNavigate={handleAnnotationClick}
                  hiddenAnnotations={hiddenAnnotations}
                />
              ))
            ) : (
              <div className="HPAG-dict-no-annotations">
                No annotations for this image
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Related */}
      {dictionaryImages.related_links?.length > 0 && (
        <div className="HPAG-dict-related">
          <span className="HPAG-dict-related-label">Related: </span>
          {dictionaryImages.related_links.slice(0, 6).map((link, idx) => (
            <a key={idx} href={`https://www.proteinatlas.org${link.href}`} target="_blank" rel="noopener noreferrer" className="HPAG-dict-related-link">
              {link.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
