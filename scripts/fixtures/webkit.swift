import Cocoa
import WebKit
class Runner: NSObject, WKScriptMessageHandler {
 var window:NSWindow!
 var web:WKWebView!
 func userContentController(_ userContentController: WKUserContentController, didReceive message:WKScriptMessage){print(message.body); fflush(stdout); NSApp.terminate(nil)}
 func start(){
  let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent();config.userContentController.add(self,name:"qa")
  web=WKWebView(frame:NSRect(x:0,y:0,width:1100,height:800),configuration:config)
  let sel=NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
  if web.responds(to:sel){typealias F = @convention(c)(AnyObject,Selector,Bool)->Void; unsafeBitCast(web.method(for:sel),to:F.self)(web,sel,false)}
  window=NSWindow(contentRect:web.frame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false);window.contentView=web;window.title="DB Sonde verification";window.makeKeyAndOrderFront(nil)
  let url=URL(fileURLWithPath:CommandLine.arguments[1]);web.loadFileURL(url,allowingReadAccessTo:url.deletingLastPathComponent())
  DispatchQueue.main.asyncAfter(deadline:.now()+35){print("TIMEOUT");fflush(stdout);NSApp.terminate(nil)}
 }
}
let app=NSApplication.shared;app.setActivationPolicy(.accessory);let runner=Runner();runner.start();app.run()
