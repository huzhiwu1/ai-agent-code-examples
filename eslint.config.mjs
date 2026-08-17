/**
 * ESLint 扁平配置（monorepo 根，含 articles/* 所有工作区）
 * 规则组合：ESLint 推荐 + typescript-eslint 推荐 + Prettier 兼容
 * 注意：eslint-config-prettier 必须放在数组最后，用于关闭与 Prettier 冲突的格式规则
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // 全局忽略：依赖产物与构建输出不参与检查
  {
    ignores: ["node_modules", "dist", "**/.pnpm-store"],
  },

  // JavaScript 官方推荐规则
  js.configs.recommended,

  // TypeScript 推荐规则
  ...tseslint.configs.recommended,

  // 关闭与 Prettier 冲突的格式规则（必须放最后）
  eslintConfigPrettier,

  // 项目级规则微调
  {
    rules: {
      // 未使用变量：降级为警告，忽略以下划线开头的参数（惯用占位符）
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  }
);
