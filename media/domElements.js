// DOM element references as a class

class DOMElements {
  constructor() {
    this.filterInput = document.getElementById('filterInput');
    this.statusTotalNum = document.getElementById('statusTotalNum');
    this.statusFilteredNum = document.getElementById('statusFilteredNum');
    this.statusBackend = document.getElementById('statusBackend');
    this.statusOp = document.getElementById('statusOp');
    this.viewport = document.getElementById('viewport');
    this.hscroll = document.getElementById('hscroll');
    this.rows = document.getElementById('rows');
    this.scrollbar = document.getElementById('scrollbar');
    this.scrollbarThumb = document.getElementById('scrollbarThumb');
    this.dynamicStyle = document.getElementById('dynamicStyles');
    this.layoutStyle = document.getElementById('layoutStyles');
    this.caseButton = document.getElementById('caseInclude');
    this.caseExcludeButton = document.getElementById('caseExclude');
    this.filterDropdown = document.getElementById('filterDropdown');
    this.filterToggle = document.getElementById('filterToggle');
    this.excludeFilterInput = document.getElementById('excludeFilterInput');
    this.excludeFilterDropdown = document.getElementById('excludeFilterDropdown');
    this.excludeFilterToggle = document.getElementById('excludeFilterToggle');
    this.searchBox = document.getElementById('searchBox');
    this.searchInput = document.getElementById('searchInput');
    this.searchStatus = document.getElementById('searchStatus');
    this.searchPrevBtn = document.getElementById('searchPrevBtn');
    this.searchNextBtn = document.getElementById('searchNextBtn');
    this.searchCloseBtn = document.getElementById('searchCloseBtn');
    this.profileToggle = document.getElementById('profileToggle');
    this.profileSelector = document.getElementById('profileSelector');
    this.profileDropdown = document.getElementById('profileDropdown');
    this.profileName = document.getElementById('profileName');
    this.profileArrow = document.getElementById('profileArrow');
  }
}
