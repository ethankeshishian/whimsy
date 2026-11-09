/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's meaning index (WhimsyAIIndex): on-device sentence embeddings
// through Apple's NaturalLanguage framework, so a page's title and text
// (and a command-bar query) become comparable vectors without ever
// leaving the Mac. One NLEmbedding per language, cached: building one is
// not free, and the index asks for one on every add() and query().

#import <Foundation/Foundation.h>
#import <NaturalLanguage/NaturalLanguage.h>

#include "nsWhimsyEmbedding.h"

#include "nsObjCExceptions.h"
#include "nsString.h"
#include "nsTArray.h"

namespace whimsy {

namespace {

// "en-US" (Gecko) -> "en" (NLLanguage is just the ISO 639-1 subtag).
NLLanguage LanguageFor(const nsACString& aLocale) {
  nsAutoCString tag(aLocale);
  int32_t dash = tag.FindChar('-');
  if (dash > 0) {
    tag.Truncate(dash);
  }
  if (tag.IsEmpty()) {
    tag.AssignLiteral("en");
  }
  return [NSString stringWithUTF8String:tag.get()];
}

// NLEmbedding instances are expensive to build; one per language is kept
// for the process' lifetime (the index's own bound limits how much this
// can matter).
NSMutableDictionary<NLLanguage, NLEmbedding*>* Cache() {
  static NSMutableDictionary<NLLanguage, NLEmbedding*>* cache;
  if (!cache) {
    cache = [[NSMutableDictionary alloc] init];
  }
  return cache;
}

// nil when no on-device sentence embedding model exists for the language.
NLEmbedding* EmbeddingFor(NLLanguage aLanguage) {
  NSMutableDictionary<NLLanguage, NLEmbedding*>* cache = Cache();
  NLEmbedding* cached = cache[aLanguage];
  if (cached) {
    return cached;
  }
  if ([cache objectForKey:aLanguage] != nil) {
    // A prior miss, recorded as NSNull below.
    return nil;
  }
  NLEmbedding* embedding = [NLEmbedding sentenceEmbeddingForLanguage:aLanguage];
  cache[aLanguage] = embedding ?: (NLEmbedding*)[NSNull null];
  return embedding;
}

}  // namespace

NS_IMPL_ISUPPORTS(nsWhimsyEmbedding, nsIWhimsyEmbedding)

NS_IMETHODIMP
nsWhimsyEmbedding::Available(const nsACString& aLocale, bool* aAvailable) {
  NS_ENSURE_ARG_POINTER(aAvailable);
  MOZ_ASSERT(NS_IsMainThread());

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  @autoreleasepool {
    *aAvailable = EmbeddingFor(LanguageFor(aLocale)) != nil;
  }
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

NS_IMETHODIMP
nsWhimsyEmbedding::Embed(const nsACString& aText, const nsACString& aLocale, nsTArray<float>& aResult) {
  MOZ_ASSERT(NS_IsMainThread());
  aResult.Clear();

  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  @autoreleasepool {
    NLEmbedding* embedding = EmbeddingFor(LanguageFor(aLocale));
    if (!embedding) {
      return NS_ERROR_NOT_AVAILABLE;
    }
    NSString* text = [[NSString alloc] initWithBytes:aText.BeginReading()
                                                length:aText.Length()
                                              encoding:NSUTF8StringEncoding];
    NSArray<NSNumber*>* vector = text.length ? [embedding vectorForString:text] : nil;
    [text release];
    if (!vector) {
      return NS_ERROR_NOT_AVAILABLE;
    }
    aResult.SetCapacity(vector.count);
    for (NSNumber* value in vector) {
      aResult.AppendElement(value.floatValue);
    }
  }
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

}  // namespace whimsy
