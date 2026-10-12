/* Python 报「No module named 'x'」时,认出缺的是哪个包、pip 上叫什么名字。
 * import 名和 pip 包名不一样的常见几个单独列出来(cv2 → opencv-python 这种),其余同名。 */

const PIP_NAME: Record<string, string> = {
  cv2: "opencv-python",
  sklearn: "scikit-learn",
  yaml: "pyyaml",
  PIL: "pillow",
  bs4: "beautifulsoup4",
  dateutil: "python-dateutil",
  dotenv: "python-dotenv",
  psycopg2: "psycopg2-binary",
  MySQLdb: "mysqlclient",
  pymysql: "PyMySQL",
  jwt: "PyJWT",
  docx: "python-docx",
  pptx: "python-pptx",
  Crypto: "pycryptodome",
  google: "google-api-python-client",
  win32api: "pywin32",
  attr: "attrs",
  magic: "python-magic",
  serial: "pyserial",
  usb: "pyusb",
  zmq: "pyzmq",
  OpenSSL: "pyOpenSSL",
  fitz: "PyMuPDF",
};

/** 从一段报错里认出缺的模块(只取顶层名,`a.b` 取 `a`);认不出返回 null。 */
export function missingModule(text: string): string | null {
  const m = /No module named ['"]([A-Za-z_][\w.]*)['"]/.exec(text);
  return m ? m[1].split(".")[0] : null;
}

/** 这个模块在 pip 上叫什么 */
export function pipNameFor(module: string): string {
  return PIP_NAME[module] ?? module;
}
