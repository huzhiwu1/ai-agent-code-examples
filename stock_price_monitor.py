import tkinter as tk
import threading
import time
import urllib.request


class StockPriceMonitor:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("股票监控")

        # 窗口属性：无边框、置顶、半透明
        self.root.overrideredirect(True)
        self.root.attributes('-topmost', True)
        self.root.attributes('-alpha', 0.85)
        self.root.config(bg='black')

        # 显示标签
        self.label = tk.Label(
            self.root,
            text="正在获取数据...",
            font=("Microsoft YaHei", 10, "bold"),
            fg="white",
            bg="black",
            padx=10,
            pady=8,
            justify=tk.LEFT
        )
        self.label.pack()

        # 绑定点击关闭事件
        self.label.bind("<Button-1>", lambda e: self.root.quit())

        # 初始位置设置
        self.update_position()

        # 监控配置列表
        # type: stock(股票) / future(期货)
        self.monitor_items = [
            # {"name": "1",   "type": "stock",  "code": "sz000422"},
            # {"name": "2",   "type": "stock",  "code": "sh600436"},
            # {"name": "1",   "type": "stock",  "code": "sz000338"},
            # {"name": "3",   "type": "stock",  "code": "sz001339"},
                        {"name": "1",   "type": "stock",  "code": "sz300456" },

            # {"name": "588870", "type": "stock", "code": "sh588080", "decimals": 3},
            # {"name": "3",   "type": "stock",  "code": "sz300581"},
            # {"name": "3",   "type": "stock",  "code": "sz300058"},

            # {"name": "1",         "type": "stock",  "code": "sz000657"},
            # {"name": "1",         "type": "stock",  "code": "sh600392"},
            # {"name": "1",         "type": "stock",  "code": "sz300390"},

            # {"name": "焦", "type": "future", "code": "JM2609"},
            # {"name": "U",  "type": "future", "code": "UR2609"},
            # {"name": "j",  "type": "future", "code": "JD2609"},
            # {"name": "A",  "type": "future", "code": "AO2609"},

            # {"name": "V",  "type": "future", "code": "V2609"},
            # {"name": "V",  "type": "future", "code": "SR2609"},
            # {"name": "1",         "type": "future",  "code": "AG2608"}

            # {
            #     "name": "3",         "type": "future",  "code": "EB2608"
            # }

            # {"name": "2",         "type": "future",  "code": "AO2609"}
        ]

        # 启动数据更新线程
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.data_loop, daemon=True)
        self.thread.start()

    def update_position(self):
        """将窗口固定在屏幕右下角"""
        self.root.update_idletasks()
        screen_w = self.root.winfo_screenwidth()
        screen_h = self.root.winfo_screenheight()

        # 获取窗口实际大小
        w = self.root.winfo_width()
        h = self.root.winfo_height()
        if w < 50:
            w = 200
        if h < 20:
            h = 60

        # 计算坐标 (距离右边 20px, 底部 50px)
        x = screen_w - w - 20
        y = screen_h - h - 50

        self.root.geometry(f"+{x}+{y}")

    def get_sina_stock_price(self, symbol_code):
        try:
            # 股票代码格式: sh600519, sz000001
            url = f"http://hq.sinajs.cn/list={symbol_code}"

            req = urllib.request.Request(url, headers={
                'Referer': 'http://finance.sina.com.cn',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            })

            with urllib.request.urlopen(req) as response:
                data = response.read().decode('gbk')

            if '="' not in data:
                return None, None

            content = data.split('="')[1].strip('";\n')
            parts = content.split(',')

            if len(parts) < 30:
                return None, None

            # A股接口数据格式:
            # 0: 股票名字, 1: 开盘, 2: 昨收, 3: 当前
            current_price = float(parts[3])
            prev_close = float(parts[2])

            if current_price == 0:
                current_price = prev_close

            return current_price, prev_close
        except Exception as e:
            print(f"{symbol_code}获取失败: {e}")
            return None, None

    def get_sina_future_price(self, symbol_code):
        """
        获取新浪国内商品期货实时行情

        @param symbol_code 期货合约代码（如 JM2606 焦煤 2026 年 6 月合约）
        @returns (最新价, 昨结算价) 元组；获取失败返回 (None, None)
        @note 期货涨跌幅以昨结算价为基准，而非昨收盘价；
              新浪国内商品期货接口需要 nf_ 前缀，否则返回空字符串
        """
        try:
            # 新浪内盘商品期货（大商所/郑商所/上期所）统一使用 nf_ 前缀
            sina_symbol = f"nf_{symbol_code.upper()}"
            url = f"http://hq.sinajs.cn/list={sina_symbol}"

            req = urllib.request.Request(url, headers={
                'Referer': 'http://finance.sina.com.cn',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            })

            with urllib.request.urlopen(req, timeout=5) as response:
                data = response.read().decode('gbk')

            if '="' not in data:
                return None, None

            content = data.split('="')[1].strip('";\n')
            # 响应内容为空表示合约不存在或代码错误
            if not content:
                return None, None

            parts = content.split(',')

            # 新浪国内商品期货（nf_）数据格式：
            # 0:名称 1:时间 2:开盘 3:最高 4:最低 5:昨结算
            # 6:买价 7:卖价 8:最新价 9:结算价 10:昨收盘
            # 11:买量 12:卖量 13:持仓量 14:成交量 15:合约代码 16:日期
            if len(parts) < 9:
                return None, None

            current_price = float(parts[8])
            # 昨结算价位于 parts[5]（nf_ 接口）
            prev_close = float(parts[5]) if parts[5] else 0.0

            # 若昨结算价异常（某些新上市合约可能为 0），回退使用昨收盘价（parts[10]）
            if prev_close == 0 and len(parts) > 10 and parts[10]:
                prev_close = float(parts[10])

            # 盘前/收盘后最新价可能为 0，回退为昨结算价以避免显示异常
            if current_price == 0:
                current_price = prev_close

            return current_price, prev_close
        except Exception as e:
            print(f"{symbol_code}获取失败: {e}")
            return None, None

    def format_price_info(self, name, price, prev_close, decimals=2):
        if price is None or prev_close is None:
            return f"{name}: 获取中...", "yellow"

        change_amount = price - prev_close

        if prev_close == 0:
            change_pct = 0.0
        else:
            change_pct = (change_amount / prev_close) * 100

        symbol = "▲" if change_amount >= 0 else "▼"

        text = f"{name}: ¥{price:.{decimals}f} {symbol} {change_pct:.2f}%"
        color = "#ff3333" if change_amount >= 0 else "#00cc00"

        return text, color

    def data_loop(self):
        while not self.stop_event.is_set():
            data_list = []

            for item in self.monitor_items:
                name = item["name"]
                code = item["code"]
                item_type = item.get("type", "stock")

                # 按品种类型分发到不同的行情获取方法（开闭原则：新增品种只需新增分支与方法）
                if item_type == "future":
                    price, prev_close = self.get_sina_future_price(code)
                else:
                    price, prev_close = self.get_sina_stock_price(code)

                decimals = item.get("decimals", 2)

                data_list.append(self.format_price_info(
                    name, price, prev_close, decimals))

            self.root.after(0, self.update_ui_multi, data_list)
            time.sleep(2)

    def update_ui_multi(self, data_list):
        if hasattr(self, 'label'):
            self.label.destroy()
            del self.label

        if not hasattr(self, 'labels'):
            self.labels = []

        while len(self.labels) < len(data_list):
            lbl = tk.Label(self.root, font=("Microsoft YaHei",
                           10, "bold"), bg="black", padx=10)
            lbl.pack(anchor="w")
            lbl.bind("<Button-1>", lambda e: self.root.quit())
            self.labels.append(lbl)

        for i, (text, color) in enumerate(data_list):
            self.labels[i].config(text=text, fg=color)

        for i in range(len(data_list), len(self.labels)):
            self.labels[i].pack_forget()

        self.update_position()

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    app = StockPriceMonitor()
    app.run()
