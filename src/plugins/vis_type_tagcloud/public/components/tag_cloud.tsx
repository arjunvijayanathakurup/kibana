/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import d3 from 'd3';
import d3TagCloud from 'd3-cloud';
import { EventEmitter } from 'events';
import {
  D3ScalingFunction,
  OrientationsFunction,
  TagCloudVisParams,
  TagType,
  JobType,
} from '../types';

const ORIENTATIONS: OrientationsFunction = {
  single: () => 0,
  'right angled': (tag: TagType) => {
    return hashWithinRange(tag.text, 2) * 90;
  },
  multiple: (tag: TagType) => {
    return hashWithinRange(tag.text, 12) * 15 - 90; // fan out 12 * 15 degrees over top-right and bottom-right quadrant (=-90 deg offset)
  },
};
const D3_SCALING_FUNCTIONS: D3ScalingFunction = {
  linear: () => d3.scale.linear(),
  log: () => d3.scale.log(),
  'square root': () => d3.scale.sqrt(),
};

export class TagCloud extends EventEmitter {
  _element: HTMLElement;
  _d3SvgContainer: d3.Selection<void>;
  _svgGroup: any;
  _size: [number, number];

  _fontFamily: string;
  _fontStyle: string;
  _fontWeight: string;
  _spiral: string;
  _timeInterval: number;
  _padding: number;

  _orientation: TagCloudVisParams['orientation'];
  _minFontSize: TagCloudVisParams['minFontSize'];
  _maxFontSize: TagCloudVisParams['maxFontSize'];
  _textScale: TagCloudVisParams['scale'];
  _optionsAsString: string | null;

  _words: string | null;

  _colorScale: string;
  _setTimeoutId: any;
  _pendingJob: any;
  _layoutIsUpdating: boolean | null;
  _allInViewBox: boolean;
  _DOMisUpdating: boolean;

  _cloudWidth: number;
  _cloudHeight: number;

  _completedJob: Record<string, any> | null;
  tag: any;

  STATUS = { COMPLETE: 0, INCOMPLETE: 1 };

  constructor(domNode: HTMLElement, colorScale: string) {
    super();

    // DOM
    this._element = domNode;
    this._d3SvgContainer = d3.select(this._element).append('svg');
    this._svgGroup = this._d3SvgContainer.append('g');
    this._size = [1, 1];
    this.resize();

    // SETTING (non-configurable)
    this._fontFamily = 'Open Sans, sans-serif';
    this._fontStyle = 'normal';
    this._fontWeight = 'normal';
    this._spiral = 'archimedean'; // layout shape
    this._timeInterval = 1000; // time allowed for layout algorithm
    this._padding = 5;

    // OPTIONS
    this._orientation = 'single';
    this._minFontSize = 10;
    this._maxFontSize = 36;
    this._textScale = 'linear';
    this._optionsAsString = null;

    // DATA
    this._words = null;

    // UTIL
    this._colorScale = colorScale;
    this._setTimeoutId = null;
    this._pendingJob = null;
    this._layoutIsUpdating = null;
    this._allInViewBox = false;
    this._DOMisUpdating = false;

    this._cloudWidth = 0;
    this._cloudHeight = 0;

    this._completedJob = null;

    this.STATUS.COMPLETE = 0;
    this.STATUS.INCOMPLETE = 0;
  }

  setOptions(options: Record<string, any>) {
    if (JSON.stringify(options) === this._optionsAsString) {
      return;
    }
    this._optionsAsString = JSON.stringify(options);
    this._orientation = options.orientation;
    this._minFontSize = Math.min(options.minFontSize, options.maxFontSize);
    this._maxFontSize = Math.max(options.minFontSize, options.maxFontSize);
    this._textScale = options.scale;
    this._invalidate(false);
  }

  resize() {
    const newWidth = this._element.offsetWidth;
    const newHeight = this._element.offsetHeight;

    if (newWidth === this._size[0] && newHeight === this._size[1]) {
      return;
    }

    const wasInside = this._size[0] >= this._cloudWidth && this._size[1] >= this._cloudHeight;
    const willBeInside = this._cloudWidth <= newWidth && this._cloudHeight <= newHeight;
    this._size[0] = newWidth;
    this._size[1] = newHeight;
    if (wasInside && willBeInside && this._allInViewBox) {
      this._invalidate(true);
    } else {
      this._invalidate(false);
    }
  }

  setData(data: any) {
    this._words = data;
    this._invalidate(false);
  }

  destroy() {
    clearTimeout(this._setTimeoutId);
    this._element.innerHTML = '';
  }

  getStatus() {
    return this._allInViewBox ? this.STATUS.COMPLETE : this.STATUS.INCOMPLETE;
  }

  _updateContainerSize() {
    this._d3SvgContainer.attr('width', this._size[0]);
    this._d3SvgContainer.attr('height', this._size[1]);
    this._svgGroup.attr('width', this._size[0]);
    this._svgGroup.attr('height', this._size[1]);
  }

  _isJobRunning() {
    return this._setTimeoutId || this._layoutIsUpdating || this._DOMisUpdating;
  }

  async _processPendingJob() {
    if (!this._pendingJob) {
      return;
    }

    if (this._isJobRunning()) {
      return;
    }

    this._completedJob = null;
    const job: JobType = await this._pickPendingJob();
    if (job.words.length) {
      if (job.refreshLayout) {
        await this._updateLayout(job);
      }
      await this._updateDOM(job);
      const cloudBBox = this._svgGroup[0][0].getBBox();
      this._cloudWidth = cloudBBox.width;
      this._cloudHeight = cloudBBox.height;
      this._allInViewBox =
        cloudBBox.x >= 0 &&
        cloudBBox.y >= 0 &&
        cloudBBox.x + cloudBBox.width <= this._element.offsetWidth &&
        cloudBBox.y + cloudBBox.height <= this._element.offsetHeight;
    } else {
      this._emptyDOM(job);
    }

    if (this._pendingJob) {
      this._processPendingJob(); // pick up next job
    } else {
      this._completedJob = job;
      this.emit('renderComplete');
    }
  }

  async _pickPendingJob() {
    return await new Promise<object>(resolve => {
      this._setTimeoutId = setTimeout(async () => {
        const job = this._pendingJob;
        this._pendingJob = null;
        this._setTimeoutId = null;
        resolve(job);
      }, 0);
    });
  }

  _emptyDOM() {
    this._svgGroup.selectAll('text').remove();
    this._cloudWidth = 0;
    this._cloudHeight = 0;
    this._allInViewBox = true;
    this._DOMisUpdating = false;
  }

  async _updateDOM(job: JobType) {
    const canSkipDomUpdate = this._pendingJob || this._setTimeoutId;
    if (canSkipDomUpdate) {
      this._DOMisUpdating = false;
      return;
    }

    this._DOMisUpdating = true;
    const affineTransform = positionWord.bind(
      null,
      this._element.offsetWidth / 2,
      this._element.offsetHeight / 2
    );
    const svgTextNodes = this._svgGroup.selectAll('text');
    const stage = svgTextNodes.data(job.words, getText);

    await new Promise(resolve => {
      const enterSelection = stage.enter();
      const enteringTags = enterSelection.append('text');
      enteringTags.style('font-size', getSizeInPixels);
      enteringTags.style('font-style', this._fontStyle);
      enteringTags.style('font-weight', () => this._fontWeight);
      enteringTags.style('font-family', () => this._fontFamily);
      enteringTags.style('fill', this.getFill.bind(this));
      enteringTags.attr('text-anchor', () => 'middle');
      enteringTags.attr('transform', affineTransform);
      enteringTags.attr('data-test-subj', getDisplayText);
      enteringTags.text(getDisplayText);

      const self = this;
      enteringTags.on({
        click(event: MouseEvent) {
          self.emit('select', event);
        },
        mouseover() {
          d3.select(this).style('cursor', 'pointer');
        },
        mouseout() {
          d3.select(this).style('cursor', 'default');
        },
      });

      const movingTags = stage.transition();
      movingTags.duration(600);
      movingTags.style('font-size', getSizeInPixels);
      movingTags.style('font-style', this._fontStyle);
      movingTags.style('font-weight', () => this._fontWeight);
      movingTags.style('font-family', () => this._fontFamily);
      movingTags.attr('transform', affineTransform);

      const exitingTags = stage.exit();
      const exitTransition = exitingTags.transition();
      exitTransition.duration(200);
      exitingTags.style('fill-opacity', 1e-6);
      exitingTags.attr('font-size', 1);
      exitingTags.remove();

      let exits = 0;
      let moves = 0;
      const resolveWhenDone = () => {
        if (exits === 0 && moves === 0) {
          this._DOMisUpdating = false;
          resolve(true);
        }
      };
      exitTransition.each(() => exits++);
      exitTransition.each('end', () => {
        exits--;
        resolveWhenDone();
      });
      movingTags.each(() => moves++);
      movingTags.each('end', () => {
        moves--;
        resolveWhenDone();
      });
    });
  }

  _makeTextSizeMapper() {
    const mapSizeToFontSize = D3_SCALING_FUNCTIONS[this._textScale]();
    if (this._words != null) {
      const range =
        this._words.length === 1
          ? [this._maxFontSize, this._maxFontSize]
          : [this._minFontSize, this._maxFontSize];
      mapSizeToFontSize.range(range);
      if (this._words) {
        mapSizeToFontSize.domain(d3.extent(this._words, getValue));
      }
    }

    return mapSizeToFontSize;
  }

  _makeNewJob() {
    return {
      refreshLayout: true,
      size: this._size.slice(),
      words: this._words,
    };
  }

  _makeJobPreservingLayout() {
    if (this._completedJob != null) {
      return {
        refreshLayout: false,
        size: this._size.slice(),
        words: this._completedJob.words.map((tag: TagType) => {
          return {
            x: tag.x,
            y: tag.y,
            rotate: tag.rotate,
            size: tag.size,
            rawText: tag.rawText || tag.text,
            displayText: tag.displayText,
            meta: tag.meta,
          };
        }),
      };
    }
  }

  _invalidate(keepLayout: boolean) {
    if (!this._words) {
      return;
    }

    this._updateContainerSize();

    const canReuseLayout = keepLayout && !this._isJobRunning() && this._completedJob;
    this._pendingJob = canReuseLayout ? this._makeJobPreservingLayout() : this._makeNewJob();
    this._processPendingJob();
  }

  async _updateLayout(job: JobType) {
    if (job.size[0] <= 0 || job.size[1] <= 0) {
      // If either width or height isn't above 0 we don't relayout anything,
      // since the d3-cloud will be stuck in an infinite loop otherwise.
      return;
    }

    const mapSizeToFontSize = this._makeTextSizeMapper();
    const tagCloudLayoutGenerator = d3TagCloud();
    tagCloudLayoutGenerator.size(job.size);
    tagCloudLayoutGenerator.padding(this._padding);
    tagCloudLayoutGenerator.rotate(ORIENTATIONS[this._orientation]);
    tagCloudLayoutGenerator.font(this._fontFamily);
    tagCloudLayoutGenerator.fontStyle(this._fontStyle);
    tagCloudLayoutGenerator.fontWeight(this._fontWeight);
    tagCloudLayoutGenerator.fontSize((tag: TagType): any => mapSizeToFontSize(tag.value));
    tagCloudLayoutGenerator.random(seed);
    tagCloudLayoutGenerator.spiral(this._spiral);
    tagCloudLayoutGenerator.words(job.words);
    tagCloudLayoutGenerator.text(getDisplayText);
    tagCloudLayoutGenerator.timeInterval(this._timeInterval);

    this._layoutIsUpdating = true;
    await new Promise(resolve => {
      tagCloudLayoutGenerator.on('end', () => {
        this._layoutIsUpdating = false;
        resolve(true);
      });
      tagCloudLayoutGenerator.start();
    });
  }

  /**
   * Returns debug info. For debugging only.
   * @return {*}
   */
  getDebugInfo(): any {
    const debug: any = {};
    debug.positions = this._completedJob
      ? this._completedJob.words.map((tag: TagType) => {
          return {
            displayText: tag.displayText,
            rawText: tag.rawText || tag.text,
            x: tag.x,
            y: tag.y,
            rotate: tag.rotate,
          };
        })
      : [];
    debug.size = {
      width: this._size[0],
      height: this._size[1],
    };
    return debug;
  }

  getFill(tag: TagType): string {
    return this._colorScale(tag.text);
  }
}

function seed(): number {
  return 0.5; // constant seed (not random) to ensure constant layouts for identical data
}

function getText(word: TagType): string {
  return word.rawText;
}

function getDisplayText(word: TagType): string {
  return word.displayText;
}

function positionWord(xTranslate: number, yTranslate: number, word: TagType): string {
  if (isNaN(word.x) || isNaN(word.y) || isNaN(word.rotate)) {
    // move off-screen
    return `translate(${xTranslate * 3}, ${yTranslate * 3})rotate(0)`;
  }

  return `translate(${word.x + xTranslate}, ${word.y + yTranslate})rotate(${word.rotate})`;
}

function getValue(tag: TagType): string | number {
  return tag.value;
}

function getSizeInPixels(tag: TagType): string {
  return `${tag.size}px`;
}

function hashWithinRange(str: string, max: any): number {
  str = JSON.stringify(str);
  let hash = 0;
  for (const ch of str) {
    hash = (hash * 31 + ch.charCodeAt(0)) % max;
  }
  return Math.abs(hash) % max;
}
