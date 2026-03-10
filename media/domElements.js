// DOM element references as a class

class DOMElements {
  constructor() {
    this.filterInput = document.getElementById('filterInput');
    this.statusTotalEl = document.getElementById('statusTotal');
    this.statusFilteredEl = document.getElementById('statusFiltered');
    this.statusOpEl = document.getElementById('statusOp');
    this.viewport = document.getElementById('viewport');
    this.hscroll = document.getElementById('hscroll');
    this.rows = document.getElementById('rows');
    this.scrollbar = document.getElementById('scrollbar');
    this.scrollbarThumb = document.getElementById('scrollbarThumb');
    this.dynamicStyleEl = document.getElementById('dynamicStyles');
    this.layoutStyleEl = document.getElementById('layoutStyles');
    this.caseButton = document.getElementById('caseInclude');
    this.caseExcludeButton = document.getElementById('caseExclude');
    this.filterDropdown = document.getElementById('filterDropdown');
    this.filterToggle = document.getElementById('filterToggle');
    this.excludeFilterInput = document.getElementById('excludeFilterInput');
    this.excludeFilterDropdown = document.getElementById('excludeFilterDropdown');
    this.excludeFilterToggle = document.getElementById('excludeFilterToggle');
    this.searchBox = document.getElementById('searchBox');
    this.searchInput = document.getElementById('searchInput');
    this.searchStatusEl = document.getElementById('searchStatus');
    this.searchPrevBtn = document.getElementById('searchPrevBtn');
    this.searchNextBtn = document.getElementById('searchNextBtn');
    this.searchCloseBtn = document.getElementById('searchCloseBtn');
  }
}
