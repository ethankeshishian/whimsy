/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's Local servers live folder: HTTP services advertised over Bonjour
// on the local network (printers' and NASes' admin pages, dev servers on
// other machines that advertise themselves). Gecko's own mDNS service
// (netwerk/dns/mdns) went away with FlyWeb, so this talks to macOS's
// mDNSResponder through dns_sd: one shared connection, a browse per type,
// a one-shot resolve per service, all on a private serial queue. The list
// goes to the main thread as JSON each time it changes.
//
// The folder starts a browse only while it is shown and stops it when it's
// collapsed, so nothing here runs in the background. macOS asks for Local
// Network access the first time; a refusal comes back as "denied".

#import <Foundation/Foundation.h>
#import <SystemConfiguration/SystemConfiguration.h>

#include <arpa/inet.h>
#include <dns_sd.h>

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "nsWhimsyBonjour.h"

#include "mozilla/Atomics.h"
#include "nsObjCExceptions.h"
#include "nsProxyRelease.h"
#include "nsString.h"
#include "nsTArray.h"
#include "nsThreadUtils.h"

// Newer SDKs name it; the value is fixed.
#ifndef kDNSServiceErr_PolicyDenied
#  define kDNSServiceErr_PolicyDenied (-65570)
#endif

namespace whimsy {

using ListenerHandle = nsMainThreadPtrHandle<nsIWhimsyBonjourListener>;

namespace {

// "_http._tcp." and "_HTTP._tcp" are the same type.
std::string NormalizeType(const char* aType) {
  std::string type(aType ? aType : "");
  while (!type.empty() && type.back() == '.') {
    type.pop_back();
  }
  for (char& c : type) {
    if (c >= 'A' && c <= 'Z') {
      c = (char)(c - 'A' + 'a');
    }
  }
  return type;
}

// The types the app's Info.plist lets it browse. macOS refuses (or, on
// some versions, ends the app over) a browse for a type not listed there.
std::vector<std::string> AllowedTypes() {
  std::vector<std::string> types;
  NSDictionary* info = [[NSBundle mainBundle] infoDictionary];
  id list = info[@"NSBonjourServices"];
  if (![list isKindOfClass:[NSArray class]]) {
    return types;
  }
  for (id item in (NSArray*)list) {
    if ([item isKindOfClass:[NSString class]] && [(NSString*)item length]) {
      types.push_back(NormalizeType([(NSString*)item UTF8String]));
    }
  }
  return types;
}

// "Ethans-MacBook-Pro.local", lowercased, or "" when unknown.
std::string LocalHostName() {
  CFStringRef name = SCDynamicStoreCopyLocalHostName(nullptr);
  if (!name) {
    return std::string();
  }
  NSString* host = [[(NSString*)name lowercaseString] stringByAppendingString:@".local"];
  CFRelease(name);
  return std::string([host UTF8String] ?: "");
}

NSString* Str(const std::string& aValue) {
  return [NSString stringWithUTF8String:aValue.c_str()] ?: @"";
}

}  // namespace

class BonjourSession final {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(BonjourSession)

  BonjourSession(std::vector<std::string>&& aTypes, const ListenerHandle& aListener)
      : mTypes(std::move(aTypes)), mListener(aListener) {
    mQueue = dispatch_queue_create("org.whimsy.bonjour", DISPATCH_QUEUE_SERIAL);
  }

  void Start() {
    MOZ_ASSERT(NS_IsMainThread());
    RefPtr<BonjourSession> self = this;
    dispatch_async(mQueue, ^{
      self->StartOnQueue();
    });
  }

  // After this the listener hears nothing more; the connection closes on
  // the queue, after which no dns_sd callback can reach this object.
  void Stop() {
    MOZ_ASSERT(NS_IsMainThread());
    if (mStopped.exchange(true)) {
      return;
    }
    RefPtr<BonjourSession> self = this;
    dispatch_async(mQueue, ^{
      self->StopOnQueue();
    });
  }

 private:
  struct Service {
    BonjourSession* mSession = nullptr;
    std::string mKey;
    std::string mName;
    std::string mType;
    std::string mDomain;
    // Browses report a service once per network interface it's seen on.
    int mInterfaces = 0;
    DNSServiceRef mResolve = nullptr;
    bool mResolved = false;
    std::string mHost;
    uint16_t mPort = 0;
    std::string mPath;
  };

  ~BonjourSession() {
    // Stop() ran (the destructor of the last holder is the queue block that
    // closed the connection), so nothing is open any more.
    MOZ_ASSERT(!mConnection);
    if (mQueue) {
      dispatch_release(mQueue);
    }
  }

  void StartOnQueue() {
    if (mStopped) {
      return;
    }
    mLocalHost = LocalHostName();
    DNSServiceErrorType err = DNSServiceCreateConnection(&mConnection);
    if (err != kDNSServiceErr_NoError || !mConnection) {
      mConnection = nullptr;
      PostError(err);
      return;
    }
    err = DNSServiceSetDispatchQueue(mConnection, mQueue);
    if (err != kDNSServiceErr_NoError) {
      DNSServiceRefDeallocate(mConnection);
      mConnection = nullptr;
      PostError(err);
      return;
    }
    for (const std::string& type : mTypes) {
      DNSServiceRef browse = mConnection;
      err = DNSServiceBrowse(&browse, kDNSServiceFlagsShareConnection, kDNSServiceInterfaceIndexAny,
                             type.c_str(), nullptr, OnBrowse, this);
      if (err == kDNSServiceErr_NoError) {
        mBrowses.push_back(browse);
      } else {
        PostError(err);
      }
    }
    // An empty list straight away, so the folder knows the browse is up.
    Post();
  }

  void StopOnQueue() {
    for (auto& entry : mServices) {
      if (entry.second->mResolve) {
        DNSServiceRefDeallocate(entry.second->mResolve);
        entry.second->mResolve = nullptr;
      }
    }
    mServices.clear();
    for (DNSServiceRef browse : mBrowses) {
      DNSServiceRefDeallocate(browse);
    }
    mBrowses.clear();
    if (mConnection) {
      DNSServiceRefDeallocate(mConnection);
      mConnection = nullptr;
    }
  }

  static void DNSSD_API OnBrowse(DNSServiceRef aRef, DNSServiceFlags aFlags, uint32_t aInterface,
                                 DNSServiceErrorType aError, const char* aName, const char* aType,
                                 const char* aDomain, void* aContext) {
    auto* self = static_cast<BonjourSession*>(aContext);
    if (self->mStopped) {
      return;
    }
    if (aError != kDNSServiceErr_NoError) {
      self->PostError(aError);
      return;
    }
    std::string type = NormalizeType(aType);
    std::string domain(aDomain ? aDomain : "");
    std::string name(aName ? aName : "");
    std::string key = name + "\x1f" + type + "\x1f" + domain;
    auto it = self->mServices.find(key);
    if (aFlags & kDNSServiceFlagsAdd) {
      if (it == self->mServices.end()) {
        auto service = std::make_unique<Service>();
        service->mSession = self;
        service->mKey = key;
        service->mName = name;
        service->mType = type;
        service->mDomain = domain;
        service->mInterfaces = 1;
        Service* raw = service.get();
        self->mServices.emplace(key, std::move(service));
        raw->mResolve = self->mConnection;
        DNSServiceErrorType err =
            DNSServiceResolve(&raw->mResolve, kDNSServiceFlagsShareConnection, aInterface, aName,
                              aType, aDomain, OnResolve, raw);
        if (err != kDNSServiceErr_NoError) {
          raw->mResolve = nullptr;
        }
      } else {
        it->second->mInterfaces++;
      }
    } else if (it != self->mServices.end()) {
      Service* service = it->second.get();
      if (--service->mInterfaces <= 0) {
        if (service->mResolve) {
          DNSServiceRefDeallocate(service->mResolve);
          service->mResolve = nullptr;
        }
        self->mDirty = self->mDirty || service->mResolved;
        self->mServices.erase(it);
      }
    }
    // A burst of changes (a device leaving takes all its services) is
    // posted once, when it's over.
    if (self->mDirty && !(aFlags & kDNSServiceFlagsMoreComing)) {
      self->Post();
    }
  }

  static void DNSSD_API OnResolve(DNSServiceRef aRef, DNSServiceFlags aFlags, uint32_t aInterface,
                                  DNSServiceErrorType aError, const char* aFullName,
                                  const char* aHost, uint16_t aPortNetworkOrder, uint16_t aTxtLen,
                                  const unsigned char* aTxt, void* aContext) {
    auto* service = static_cast<Service*>(aContext);
    BonjourSession* self = service->mSession;
    // One answer is enough: the resolve ends here either way.
    if (service->mResolve) {
      DNSServiceRefDeallocate(service->mResolve);
      service->mResolve = nullptr;
    }
    if (self->mStopped || aError != kDNSServiceErr_NoError || !aHost) {
      return;
    }
    std::string host(aHost);
    while (!host.empty() && host.back() == '.') {
      host.pop_back();
    }
    service->mHost = host;
    service->mPort = ntohs(aPortNetworkOrder);
    service->mPath.clear();
    uint8_t pathLen = 0;
    const void* path = TXTRecordGetValuePtr(aTxtLen, aTxt, "path", &pathLen);
    if (path && pathLen) {
      service->mPath.assign(static_cast<const char*>(path), pathLen);
    }
    service->mResolved = !host.empty() && service->mPort != 0;
    self->Post();
  }

  // On the queue: the resolved services, as JSON, to the main thread.
  void Post() {
    mDirty = false;
    nsCString json;
    @autoreleasepool {
      NSMutableArray* out = [NSMutableArray arrayWithCapacity:mServices.size()];
      for (const auto& entry : mServices) {
        const Service& s = *entry.second;
        if (!s.mResolved) {
          continue;
        }
        std::string lowerHost = s.mHost;
        for (char& c : lowerHost) {
          if (c >= 'A' && c <= 'Z') {
            c = (char)(c - 'A' + 'a');
          }
        }
        NSMutableDictionary* item = [NSMutableDictionary dictionary];
        item[@"name"] = Str(s.mName);
        item[@"type"] = Str(s.mType);
        item[@"domain"] = Str(s.mDomain);
        item[@"host"] = Str(s.mHost);
        item[@"port"] = @(s.mPort);
        if (!s.mPath.empty()) {
          item[@"path"] = Str(s.mPath);
        }
        item[@"local"] = @(!mLocalHost.empty() && lowerHost == mLocalHost ? YES : NO);
        [out addObject:item];
      }
      NSData* data = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
      NSString* string =
          data ? [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease]
               : nil;
      json.Assign(string ? [string UTF8String] : "[]");
    }
    RefPtr<BonjourSession> self = this;
    NS_DispatchToMainThread(
        NS_NewRunnableFunction("WhimsyBonjour::ServicesChanged", [self, json]() {
          if (!self->mStopped) {
            self->mListener->OnServicesChanged(json);
          }
        }));
  }

  void PostError(DNSServiceErrorType aError) {
    // One error per browse is enough for the folder.
    if (mErrored) {
      return;
    }
    mErrored = true;
    nsAutoCString reason;
    if (aError == kDNSServiceErr_PolicyDenied || aError == kDNSServiceErr_NoAuth) {
      reason.AssignLiteral("denied");
    } else {
      reason.AssignLiteral("failed");
    }
    RefPtr<BonjourSession> self = this;
    NS_DispatchToMainThread(NS_NewRunnableFunction("WhimsyBonjour::Error", [self, reason]() {
      if (!self->mStopped) {
        self->mListener->OnError(reason);
      }
    }));
  }

  dispatch_queue_t mQueue = nullptr;
  const std::vector<std::string> mTypes;
  ListenerHandle mListener;
  mozilla::Atomic<bool> mStopped{false};
  // Queue only.
  DNSServiceRef mConnection = nullptr;
  std::vector<DNSServiceRef> mBrowses;
  std::map<std::string, std::unique_ptr<Service>> mServices;
  std::string mLocalHost;
  bool mErrored = false;
  bool mDirty = false;
};

NS_IMPL_ISUPPORTS(nsWhimsyBonjour, nsIWhimsyBonjour)

nsWhimsyBonjour::nsWhimsyBonjour() = default;

nsWhimsyBonjour::~nsWhimsyBonjour() {
  if (mSession) {
    mSession->Stop();
    mSession = nullptr;
  }
}

NS_IMETHODIMP
nsWhimsyBonjour::GetAllowedTypes(nsTArray<nsCString>& aTypes) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  aTypes.Clear();
  for (const std::string& type : AllowedTypes()) {
    aTypes.AppendElement(nsCString(type.c_str()));
  }
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyBonjour::Start(const nsTArray<nsCString>& aTypes, nsIWhimsyBonjourListener* aListener) {
  NS_ENSURE_ARG_POINTER(aListener);
  MOZ_ASSERT(NS_IsMainThread());

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  if (mSession) {
    mSession->Stop();
    mSession = nullptr;
  }

  ListenerHandle listener(
      new nsMainThreadPtrHolder<nsIWhimsyBonjourListener>("WhimsyBonjour::Listener", aListener));

  std::vector<std::string> allowed = AllowedTypes();
  std::vector<std::string> types;
  for (const nsCString& requested : aTypes) {
    std::string type = NormalizeType(requested.get());
    bool listed = false;
    for (const std::string& a : allowed) {
      listed = listed || a == type;
    }
    bool seen = false;
    for (const std::string& t : types) {
      seen = seen || t == type;
    }
    if (listed && !seen) {
      types.push_back(type);
    }
  }
  if (types.empty()) {
    NS_DispatchToMainThread(NS_NewRunnableFunction("WhimsyBonjour::NoTypes", [listener]() {
      listener->OnError("missing-bonjour-services"_ns);
    }));
    return NS_OK;
  }

  mSession = new BonjourSession(std::move(types), listener);
  mSession->Start();
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyBonjour::Stop() {
  MOZ_ASSERT(NS_IsMainThread());
  if (mSession) {
    mSession->Stop();
    mSession = nullptr;
  }
  return NS_OK;
}

NS_IMETHODIMP
nsWhimsyBonjour::GetBrowsing(bool* aBrowsing) {
  NS_ENSURE_ARG_POINTER(aBrowsing);
  *aBrowsing = !!mSession;
  return NS_OK;
}

}  // namespace whimsy
