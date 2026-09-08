# -*- coding: utf-8 -*-
"""
i18n 多语言核心模块 (Python 标准库实现, 无第三方依赖)

作用:
    1. 从 locales/{lang}.json 加载语言表 (嵌套结构, key 用点路径如 "status.ready")
    2. 提供 t(key, **kwargs) 翻译函数, 支持 {placeholder} 占位符
    3. switch(lang) 切换语言并通知所有注册的回调 (用于 GUI 实时刷新)
    4. on_change(callback) 注册语言变更回调

用法:
    import i18n
    i18n.translator.switch('en')      # 初始化或切换
    text = i18n.t('status.ready')    # 翻译
    i18n.translator.on_change(my_refresh_func)  # 注册回调

语言表文件结构 (locales/zh.json):
    {
        "window": {"title": "..."},
        "status": {"ready": "...", "port": "端口: {port}"},
        "buttons": {"install": "...", ...}
    }

打包说明 (PyInstaller --onefile):
    --add-data "locales;locales"

注意 (windowed 模式坑, 2026-09-08):
    用 PyInstaller --windowed 打出 exe 时, sys.stdout / sys.stderr 会被置为 None,
    任何直接 sys.stderr.write(...) 都会抛 AttributeError: 'NoneType' object has
    no attribute 'write'. 因此本模块内所有日志输出必须经下方 _safe_write / _warn
    兜底 (stream 为 None 时静默丢弃), 绝不直接写 sys.stderr.
"""

import os
import sys
import json


def _safe_write(stream, text):
    """向给定 stream 安全写一行: stream 为 None (windowed 无控制台) 时静默丢弃.
    避免 PyInstaller --windowed 下 sys.stdout/stderr 为 None 导致崩溃."""
    if stream is None:
        return
    try:
        stream.write(text)
    except Exception:
        # 极端情况下 stream 写入失败也不影响主流程
        pass


def _warn(text):
    """日志输出到 stderr 的兜底封装: windowed 打包时 stderr=None 也不会崩."""
    _safe_write(sys.stderr, text)


def _get_base_dir():
    """程序根目录: 源码模式取脚本所在目录, 打包为 exe 后取 exe 所在目录
    (与 launcher.py 里的 get_base_dir() 保持一致)"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


class Translator:
    """多语言翻译器: 加载嵌套 JSON 语言表, 支持点路径 key, 支持占位符, 支持切换回调"""

    def __init__(self, default_lang="zh"):
        self.current_lang = default_lang
        self._translations = {}        # 当前语言的扁平化 key→value 字典
        self._change_callbacks = []    # 语言变更回调列表
        self._base_dir = _get_base_dir()
        self._load_language(default_lang)

    # ---------- 语言加载 ----------
    def _load_language(self, lang_code):
        """从 locales/{lang_code}.json 加载语言表, 扁平化嵌套 key"""
        locales_dir = os.path.join(self._base_dir, "locales")
        json_path = os.path.join(locales_dir, lang_code + ".json")
        self._translations = {}
        if not os.path.isfile(json_path):
            # 文件不存在时保持空字典, t() 会 fallback 返回 key
            _warn("[i18n] Warning: locale file not found: %s\n" % json_path)
            return
        try:
            with open(json_path, "r", encoding="utf-8") as file_handle:
                raw_data = json.load(file_handle)
            self._translations = self._flatten_dict(raw_data)
        except Exception as error:
            _warn("[i18n] Warning: failed to load %s: %s\n" % (json_path, error))
            self._translations = {}

    @staticmethod
    def _flatten_dict(nested_dict, parent_key=""):
        """把嵌套字典扁平化为点路径 key 的字典
        例: {"a": {"b": "c"}} → {"a.b": "c"}"""
        flat_result = {}
        if not isinstance(nested_dict, dict):
            return flat_result
        for key, value in nested_dict.items():
            full_key = key if not parent_key else parent_key + "." + key
            if isinstance(value, dict):
                flat_result.update(Translator._flatten_dict(value, full_key))
            else:
                flat_result[full_key] = value
        return flat_result

    # ---------- 翻译 ----------
    def t(self, key, **kwargs):
        """翻译 key, 支持 {placeholder} 占位符.
        key 不存在时 fallback 返回 key 本身 (方便开发期发现遗漏)."""
        value = self._translations.get(key)
        if value is None:
            return key
        if kwargs and isinstance(value, str):
            try:
                return value.format(**kwargs)
            except (KeyError, IndexError, ValueError):
                # 占位符参数不匹配时, 直接返回原始 value 避免报错
                return value
        return value

    # ---------- 语言切换 ----------
    def switch(self, lang_code):
        """切换语言, 重新加载语言表, 并通知所有回调"""
        if lang_code == self.current_lang and self._translations:
            return   # 相同语言且已加载, 不重复操作
        self.current_lang = lang_code
        self._load_language(lang_code)
        # 通知所有回调
        for callback in self._change_callbacks:
            try:
                callback()
            except Exception as error:
                _warn("[i18n] Warning: change callback error: %s\n" % error)

    # ---------- 回调注册 ----------
    def on_change(self, callback):
        """注册语言变更回调函数. callback 无参数, 在 switch() 成功加载后调用."""
        if callable(callback) and callback not in self._change_callbacks:
            self._change_callbacks.append(callback)

    def off_change(self, callback):
        """注销语言变更回调"""
        if callback in self._change_callbacks:
            self._change_callbacks.remove(callback)

    # ---------- 工具 ----------
    def available_languages(self):
        """返回 locales 目录下所有可用的语言代码列表 (不含 .json 后缀)"""
        locales_dir = os.path.join(self._base_dir, "locales")
        if not os.path.isdir(locales_dir):
            return []
        result = []
        for entry in os.listdir(locales_dir):
            if entry.endswith(".json"):
                result.append(entry[:-5])   # 去掉 .json
        return sorted(result)


# ---------- 模块级单例 & 便捷函数 ----------
translator = Translator(default_lang="zh")


def t(key, **kwargs):
    """便捷翻译函数, 等价于 translator.t(key, **kwargs)"""
    return translator.t(key, **kwargs)
