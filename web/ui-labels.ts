import type { Lang } from "./i18n";

// Labels for the xdev-ui parts the console uses; the parts ship English defaults.
const labels = {
  en: {
    appShell: { openNav: "Open navigation", closeNav: "Close navigation", skipToContent: "Skip to content", nav: "Navigation", collapseNav: "Collapse sidebar", expandNav: "Expand sidebar" },
    breadcrumb: { breadcrumb: "Breadcrumb" },
    tabStrip: { skipped: "Skipped", unsaved: "Unsaved changes", newTab: "New tab", close: (name: string) => `Close ${name}` },
    navList: { nav: "Sections" },
    toast: { dismiss: "Dismiss" },
    dialog: { confirm: "OK", cancel: "Cancel" },
    formDialog: { submit: "Save", cancel: "Cancel", saving: "Saving" },
    codeBlock: { copy: "Copy", copied: "Copied" },
    searchInput: { search: "Search", clear: "Clear search", count: (n: number) => (n === 1 ? "1 result" : `${n} results`) },
    searchPicker: { clear: "Clear search" },
    field: { show: "Show", hide: "Hide" },
    combobox: { noResults: "No match", create: (text: string) => `Use “${text}”`, remove: (label: string) => `Remove ${label}`, clear: "Clear" },
    bulkBar: { region: "Bulk actions", selected: (n: number) => `${n} selected`, clear: "Clear selection" },
    sortableList: {
      handle: (name: string) => `Drag to reorder: ${name}`,
      lifted: (name: string) => `${name} lifted. Use the up and down arrow keys to move it, Space to drop it, Escape to cancel.`,
      moved: (pos: number, total: number) => `Moved to position ${pos} of ${total}.`,
      dropped: (pos: number, total: number) => `Dropped at position ${pos} of ${total}.`,
      cancelled: "Reorder cancelled. The item is back in its place.",
    },
    statTile: { loading: "Loading" },
    dataTable: {
      selectAll: "Select all rows",
      selectRow: (name: string) => `Select ${name}`,
      sortedAsc: "sorted ascending",
      sortedDesc: "sorted descending",
      loading: "Loading",
    },
  },
  vi: {
    appShell: { openNav: "Mở điều hướng", closeNav: "Đóng điều hướng", skipToContent: "Chuyển đến nội dung", nav: "Điều hướng", collapseNav: "Thu gọn thanh bên", expandNav: "Mở rộng thanh bên" },
    breadcrumb: { breadcrumb: "Đường dẫn" },
    tabStrip: { skipped: "Đã bỏ qua", unsaved: "Chưa lưu", newTab: "Tab mới", close: (name: string) => `Đóng ${name}` },
    navList: { nav: "Mục" },
    toast: { dismiss: "Đóng" },
    dialog: { confirm: "Đồng ý", cancel: "Hủy" },
    formDialog: { submit: "Lưu", cancel: "Hủy", saving: "Đang lưu" },
    codeBlock: { copy: "Sao chép", copied: "Đã sao chép" },
    searchInput: { search: "Tìm", clear: "Xóa tìm kiếm", count: (n: number) => `${n} kết quả` },
    searchPicker: { clear: "Xóa tìm kiếm" },
    field: { show: "Hiện", hide: "Ẩn" },
    combobox: { noResults: "Không có kết quả", create: (text: string) => `Dùng “${text}”`, remove: (label: string) => `Bỏ ${label}`, clear: "Xóa" },
    bulkBar: { region: "Thao tác hàng loạt", selected: (n: number) => `Đã chọn ${n}`, clear: "Bỏ chọn" },
    sortableList: {
      handle: (name: string) => `Kéo để sắp xếp: ${name}`,
      lifted: (name: string) => `Đã nhấc ${name}. Dùng phím mũi tên lên, xuống để di chuyển, Space để thả, Escape để hủy.`,
      moved: (pos: number, total: number) => `Đã chuyển tới vị trí ${pos} trên ${total}.`,
      dropped: (pos: number, total: number) => `Đã thả ở vị trí ${pos} trên ${total}.`,
      cancelled: "Đã hủy sắp xếp. Mục đã về chỗ cũ.",
    },
    statTile: { loading: "Đang tải" },
    dataTable: {
      selectAll: "Chọn tất cả các dòng",
      selectRow: (name: string) => `Chọn ${name}`,
      sortedAsc: "sắp xếp tăng dần",
      sortedDesc: "sắp xếp giảm dần",
      loading: "Đang tải",
    },
  },
};

export function ui(lang: Lang) {
  return labels[lang];
}
