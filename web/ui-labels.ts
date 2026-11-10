import type { Lang } from "./i18n";

// Labels for the xdev-ui parts the console uses; the parts ship English defaults.
const labels = {
  en: {
    appShell: { openNav: "Open navigation", closeNav: "Close navigation", skipToContent: "Skip to content", nav: "Navigation" },
    navList: { nav: "Sections" },
    toast: { dismiss: "Dismiss" },
    dialog: { confirm: "OK", cancel: "Cancel" },
    formDialog: { submit: "Save", cancel: "Cancel", saving: "Saving" },
    codeBlock: { copy: "Copy", copied: "Copied" },
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
    appShell: { openNav: "Mở điều hướng", closeNav: "Đóng điều hướng", skipToContent: "Chuyển đến nội dung", nav: "Điều hướng" },
    navList: { nav: "Mục" },
    toast: { dismiss: "Đóng" },
    dialog: { confirm: "Đồng ý", cancel: "Hủy" },
    formDialog: { submit: "Lưu", cancel: "Hủy", saving: "Đang lưu" },
    codeBlock: { copy: "Sao chép", copied: "Đã sao chép" },
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
