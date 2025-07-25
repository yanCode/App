import {useFocusEffect, useIsFocused, useNavigation} from '@react-navigation/native';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {NativeScrollEvent, NativeSyntheticEvent, StyleProp, ViewStyle, ViewToken} from 'react-native';
import {View} from 'react-native';
import FullPageErrorView from '@components/BlockingViews/FullPageErrorView';
import FullPageOfflineBlockingView from '@components/BlockingViews/FullPageOfflineBlockingView';
import SearchTableHeader from '@components/SelectionList/SearchTableHeader';
import type {ReportActionListItemType, SearchListItem, SelectionListHandle, TransactionGroupListItemType, TransactionListItemType} from '@components/SelectionList/types';
import SearchRowSkeleton from '@components/Skeletons/SearchRowSkeleton';
import useLocalize from '@hooks/useLocalize';
import useNetwork from '@hooks/useNetwork';
import useOnyx from '@hooks/useOnyx';
import usePrevious from '@hooks/usePrevious';
import useResponsiveLayout from '@hooks/useResponsiveLayout';
import useSearchHighlightAndScroll from '@hooks/useSearchHighlightAndScroll';
import useThemeStyles from '@hooks/useThemeStyles';
import {turnOffMobileSelectionMode, turnOnMobileSelectionMode} from '@libs/actions/MobileSelectionMode';
import {openSearch, updateSearchResultsWithTransactionThreadReportID} from '@libs/actions/Search';
import Timing from '@libs/actions/Timing';
import {canUseTouchScreen} from '@libs/DeviceCapabilities';
import Log from '@libs/Log';
import isSearchTopmostFullScreenRoute from '@libs/Navigation/helpers/isSearchTopmostFullScreenRoute';
import type {PlatformStackNavigationProp} from '@libs/Navigation/PlatformStackNavigation/types';
import Performance from '@libs/Performance';
import {getIOUActionForTransactionID} from '@libs/ReportActionsUtils';
import {canEditFieldOfMoneyRequest, generateReportID} from '@libs/ReportUtils';
import {buildSearchQueryString} from '@libs/SearchQueryUtils';
import {
    getListItem,
    getSections,
    getSortedSections,
    getWideAmountIndicators,
    isReportActionListItemType,
    isSearchDataLoaded,
    isSearchResultsEmpty as isSearchResultsEmptyUtil,
    isTaskListItemType,
    isTransactionGroupListItemType,
    isTransactionListItemType,
    shouldShowEmptyState,
    shouldShowYear as shouldShowYearUtil,
} from '@libs/SearchUIUtils';
import {isOnHold, isTransactionPendingDelete} from '@libs/TransactionUtils';
import Navigation from '@navigation/Navigation';
import type {SearchFullscreenNavigatorParamList} from '@navigation/types';
import EmptySearchView from '@pages/Search/EmptySearchView';
import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import ROUTES from '@src/ROUTES';
import type {ReportAction} from '@src/types/onyx';
import type SearchResults from '@src/types/onyx/SearchResults';
import {isEmptyObject} from '@src/types/utils/EmptyObject';
import {useSearchContext} from './SearchContext';
import SearchList from './SearchList';
import SearchScopeProvider from './SearchScopeProvider';
import type {SearchColumnType, SearchParams, SearchQueryJSON, SelectedTransactionInfo, SelectedTransactions, SortOrder} from './types';

type SearchProps = {
    queryJSON: SearchQueryJSON;
    onSearchListScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    contentContainerStyle?: StyleProp<ViewStyle>;
    searchResults?: SearchResults;
    handleSearch: (value: SearchParams) => void;
    isMobileSelectionModeEnabled: boolean;
};

function mapTransactionItemToSelectedEntry(item: TransactionListItemType, reportActions: ReportAction[]): [string, SelectedTransactionInfo] {
    return [
        item.keyForList,
        {
            isSelected: true,
            canDelete: item.canDelete,
            canHold: item.canHold,
            isHeld: isOnHold(item),
            canUnhold: item.canUnhold,
            canChangeReport: canEditFieldOfMoneyRequest(getIOUActionForTransactionID(reportActions, item.transactionID), CONST.EDIT_REQUEST_FIELD.REPORT),
            action: item.action,
            reportID: item.reportID,
            policyID: item.policyID,
            amount: item.modifiedAmount ?? item.amount,
        },
    ];
}

function mapToTransactionItemWithAdditionalInfo(item: TransactionListItemType, selectedTransactions: SelectedTransactions, canSelectMultiple: boolean, shouldAnimateInHighlight: boolean) {
    return {...item, shouldAnimateInHighlight, isSelected: selectedTransactions[item.keyForList]?.isSelected && canSelectMultiple};
}

function mapToItemWithAdditionalInfo(item: SearchListItem, selectedTransactions: SelectedTransactions, canSelectMultiple: boolean, shouldAnimateInHighlight: boolean) {
    if (isTaskListItemType(item)) {
        return {
            ...item,
            shouldAnimateInHighlight,
        };
    }

    if (isReportActionListItemType(item)) {
        return {
            ...item,
            shouldAnimateInHighlight,
        };
    }

    return isTransactionListItemType(item)
        ? mapToTransactionItemWithAdditionalInfo(item, selectedTransactions, canSelectMultiple, shouldAnimateInHighlight)
        : {
              ...item,
              shouldAnimateInHighlight,
              transactions: item.transactions?.map((transaction) => mapToTransactionItemWithAdditionalInfo(transaction, selectedTransactions, canSelectMultiple, shouldAnimateInHighlight)),
              isSelected:
                  item?.transactions?.length > 0 &&
                  item.transactions?.filter((t) => !isTransactionPendingDelete(t)).every((transaction) => selectedTransactions[transaction.keyForList]?.isSelected && canSelectMultiple),
          };
}

function prepareTransactionsList(item: TransactionListItemType, selectedTransactions: SelectedTransactions, reportActions: ReportAction[]) {
    if (selectedTransactions[item.keyForList]?.isSelected) {
        const {[item.keyForList]: omittedTransaction, ...transactions} = selectedTransactions;

        return transactions;
    }

    return {
        ...selectedTransactions,
        [item.keyForList]: {
            isSelected: true,
            canDelete: item.canDelete,
            canHold: item.canHold,
            isHeld: isOnHold(item),
            canUnhold: item.canUnhold,
            canChangeReport: canEditFieldOfMoneyRequest(getIOUActionForTransactionID(reportActions, item.transactionID), CONST.EDIT_REQUEST_FIELD.REPORT),
            action: item.action,
            reportID: item.reportID,
            policyID: item.policyID,
            amount: Math.abs(item.modifiedAmount || item.amount),
        },
    };
}

function Search({queryJSON, searchResults, onSearchListScroll, contentContainerStyle, handleSearch, isMobileSelectionModeEnabled}: SearchProps) {
    const {isOffline} = useNetwork();
    const {shouldUseNarrowLayout} = useResponsiveLayout();
    const styles = useThemeStyles();
    // We need to use isSmallScreenWidth instead of shouldUseNarrowLayout for enabling the selection mode on small screens only
    // eslint-disable-next-line rulesdir/prefer-shouldUseNarrowLayout-instead-of-isSmallScreenWidth
    const {isSmallScreenWidth, isLargeScreenWidth} = useResponsiveLayout();
    const navigation = useNavigation<PlatformStackNavigationProp<SearchFullscreenNavigatorParamList>>();
    const isFocused = useIsFocused();
    const {
        setCurrentSearchHash,
        setSelectedTransactions,
        selectedTransactions,
        clearSelectedTransactions,
        shouldTurnOffSelectionMode,
        setShouldShowFiltersBarLoading,
        lastSearchType,
        setShouldShowExportModeOption,
        isExportMode,
        setExportMode,
    } = useSearchContext();
    const [offset, setOffset] = useState(0);

    const {type, status, sortBy, sortOrder, hash, groupBy} = queryJSON;

    const [transactions] = useOnyx(ONYXKEYS.COLLECTION.TRANSACTION, {canBeMissing: true});
    const previousTransactions = usePrevious(transactions);
    const [reportActions] = useOnyx(ONYXKEYS.COLLECTION.REPORT_ACTIONS, {canBeMissing: true});
    const previousReportActions = usePrevious(reportActions);
    const reportActionsArray = useMemo(
        () =>
            Object.values(reportActions ?? {})
                .filter((reportAction) => !!reportAction)
                .flatMap((filteredReportActions) => Object.values(filteredReportActions ?? {})),
        [reportActions],
    );
    const {translate} = useLocalize();
    const searchListRef = useRef<SelectionListHandle | null>(null);

    useFocusEffect(
        useCallback(() => {
            clearSelectedTransactions(hash);
            setCurrentSearchHash(hash);
        }, [hash, clearSelectedTransactions, setCurrentSearchHash]),
    );

    const isSearchResultsEmpty = !searchResults?.data || isSearchResultsEmptyUtil(searchResults);

    useEffect(() => {
        if (!isFocused) {
            return;
        }

        const selectedKeys = Object.keys(selectedTransactions).filter((key) => selectedTransactions[key]);
        if (selectedKeys.length === 0 && isMobileSelectionModeEnabled && shouldTurnOffSelectionMode) {
            turnOffMobileSelectionMode();
        }

        // We don't want to run the effect on isFocused change as we only need it to early return when it is false.
        // eslint-disable-next-line react-compiler/react-compiler
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedTransactions, isMobileSelectionModeEnabled, shouldTurnOffSelectionMode]);

    useEffect(() => {
        const selectedKeys = Object.keys(selectedTransactions).filter((key) => selectedTransactions[key]);
        if (!isSmallScreenWidth) {
            if (selectedKeys.length === 0 && isMobileSelectionModeEnabled) {
                turnOffMobileSelectionMode();
            }
            return;
        }
        if (selectedKeys.length > 0 && !isMobileSelectionModeEnabled && !isSearchResultsEmpty) {
            turnOnMobileSelectionMode();
        }
        // eslint-disable-next-line react-compiler/react-compiler
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isSmallScreenWidth, selectedTransactions, isMobileSelectionModeEnabled]);

    useEffect(() => {
        if (isOffline) {
            return;
        }

        handleSearch({queryJSON, offset});
    }, [handleSearch, isOffline, offset, queryJSON]);

    useEffect(() => {
        openSearch();
    }, []);

    const {newSearchResultKey, handleSelectionListScroll} = useSearchHighlightAndScroll({
        searchResults,
        transactions,
        previousTransactions,
        queryJSON,
        offset,
        reportActions,
        previousReportActions,
    });

    // There's a race condition in Onyx which makes it return data from the previous Search, so in addition to checking that the data is loaded
    // we also need to check that the searchResults matches the type and status of the current search
    const isDataLoaded = isSearchDataLoaded(searchResults?.search, queryJSON) ?? false;

    const shouldShowLoadingState = !isOffline && (!isDataLoaded || (!!searchResults?.search.isLoading && Array.isArray(searchResults?.data) && searchResults?.data.length === 0));
    const shouldShowLoadingMoreItems = !shouldShowLoadingState && searchResults?.search?.isLoading && searchResults?.search?.offset > 0;
    const prevIsSearchResultEmpty = usePrevious(isSearchResultsEmpty);

    const data = useMemo(() => {
        if (searchResults === undefined || !isDataLoaded) {
            return [];
        }
        return getSections(type, status, searchResults.data, searchResults.search, groupBy);
    }, [searchResults, isDataLoaded, type, status, groupBy]);

    useEffect(() => {
        /** We only want to display the skeleton for the status filters the first time we load them for a specific data type */
        setShouldShowFiltersBarLoading(shouldShowLoadingState && lastSearchType !== type);
    }, [lastSearchType, setShouldShowFiltersBarLoading, shouldShowLoadingState, type]);

    // When new data load, selectedTransactions is updated in next effect. We use this flag to whether selection is updated
    const isRefreshingSelection = useRef(false);

    useEffect(() => {
        if (type === CONST.SEARCH.DATA_TYPES.CHAT) {
            return;
        }
        const newTransactionList: SelectedTransactions = {};
        if (groupBy) {
            data.forEach((transactionGroup) => {
                if (!Object.hasOwn(transactionGroup, 'transactions') || !('transactions' in transactionGroup)) {
                    return;
                }
                transactionGroup.transactions.forEach((transaction) => {
                    if (!Object.keys(selectedTransactions).includes(transaction.transactionID) && !isExportMode) {
                        return;
                    }
                    newTransactionList[transaction.transactionID] = {
                        action: transaction.action,
                        canHold: transaction.canHold,
                        isHeld: isOnHold(transaction),
                        canUnhold: transaction.canUnhold,
                        canChangeReport: canEditFieldOfMoneyRequest(getIOUActionForTransactionID(reportActionsArray, transaction.transactionID), CONST.EDIT_REQUEST_FIELD.REPORT),
                        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
                        isSelected: isExportMode || selectedTransactions[transaction.transactionID].isSelected,
                        canDelete: transaction.canDelete,
                        reportID: transaction.reportID,
                        policyID: transaction.policyID,
                        amount: transaction.modifiedAmount ?? transaction.amount,
                    };
                });
            });
        } else {
            data.forEach((transaction) => {
                if (!Object.hasOwn(transaction, 'transactionID') || !('transactionID' in transaction)) {
                    return;
                }
                if (!Object.keys(selectedTransactions).includes(transaction.transactionID) && !isExportMode) {
                    return;
                }
                newTransactionList[transaction.transactionID] = {
                    action: transaction.action,
                    canHold: transaction.canHold,
                    isHeld: isOnHold(transaction),
                    canUnhold: transaction.canUnhold,
                    canChangeReport: canEditFieldOfMoneyRequest(getIOUActionForTransactionID(reportActionsArray, transaction.transactionID), CONST.EDIT_REQUEST_FIELD.REPORT),
                    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
                    isSelected: isExportMode || selectedTransactions[transaction.transactionID].isSelected,
                    canDelete: transaction.canDelete,
                    reportID: transaction.reportID,
                    policyID: transaction.policyID,
                    amount: transaction.modifiedAmount ?? transaction.amount,
                };
            });
        }
        if (isEmptyObject(newTransactionList)) {
            return;
        }

        setSelectedTransactions(newTransactionList, data);

        isRefreshingSelection.current = true;
        // eslint-disable-next-line react-compiler/react-compiler, react-hooks/exhaustive-deps
    }, [data, setSelectedTransactions, isExportMode]);

    useEffect(() => {
        if (!isSearchResultsEmpty || prevIsSearchResultEmpty) {
            return;
        }
        turnOffMobileSelectionMode();
    }, [isSearchResultsEmpty, prevIsSearchResultEmpty]);

    useEffect(
        () => () => {
            if (isSearchTopmostFullScreenRoute()) {
                return;
            }
            clearSelectedTransactions();
            turnOffMobileSelectionMode();
        },
        [isFocused, clearSelectedTransactions],
    );

    // When selectedTransactions is updated, we confirm that selection is refreshed
    useEffect(() => {
        isRefreshingSelection.current = false;
    }, [selectedTransactions]);

    useEffect(() => {
        if (!data.length || isRefreshingSelection.current || !isFocused) {
            return;
        }
        const areItemsGrouped = !!groupBy;
        const flattenedItems = areItemsGrouped ? (data as TransactionGroupListItemType[]).flatMap((item) => item.transactions) : data;
        const isAllSelected = flattenedItems.length === Object.keys(selectedTransactions).length;

        setShouldShowExportModeOption(!!(isAllSelected && searchResults?.search?.hasMoreResults));
        if (!isAllSelected) {
            setExportMode(false);
        }
    }, [isFocused, data, searchResults?.search?.hasMoreResults, selectedTransactions, setExportMode, setShouldShowExportModeOption, groupBy]);

    const toggleTransaction = useCallback(
        (item: SearchListItem) => {
            if (isReportActionListItemType(item)) {
                return;
            }
            if (isTaskListItemType(item)) {
                return;
            }
            if (isTransactionListItemType(item)) {
                if (!item.keyForList) {
                    return;
                }
                if (isTransactionPendingDelete(item)) {
                    return;
                }
                setSelectedTransactions(prepareTransactionsList(item, selectedTransactions, reportActionsArray), data);
                return;
            }

            if (item.transactions.some((transaction) => selectedTransactions[transaction.keyForList]?.isSelected)) {
                const reducedSelectedTransactions: SelectedTransactions = {...selectedTransactions};

                item.transactions.forEach((transaction) => {
                    delete reducedSelectedTransactions[transaction.keyForList];
                });

                setSelectedTransactions(reducedSelectedTransactions, data);
                return;
            }

            setSelectedTransactions(
                {
                    ...selectedTransactions,
                    ...Object.fromEntries(
                        item.transactions.filter((t) => !isTransactionPendingDelete(t)).map((transactionItem) => mapTransactionItemToSelectedEntry(transactionItem, reportActionsArray)),
                    ),
                },
                data,
            );
        },
        [data, reportActionsArray, selectedTransactions, setSelectedTransactions],
    );

    const openReport = useCallback(
        (item: SearchListItem) => {
            if (isMobileSelectionModeEnabled) {
                toggleTransaction(item);
                return;
            }

            const isFromSelfDM = item.reportID === CONST.REPORT.UNREPORTED_REPORT_ID;
            const isTransactionItem = isTransactionListItemType(item);

            const reportID =
                isTransactionItem && (!item.isFromOneTransactionReport || isFromSelfDM) && item.transactionThreadReportID !== CONST.REPORT.UNREPORTED_REPORT_ID
                    ? item.transactionThreadReportID
                    : item.reportID;

            if (!reportID) {
                return;
            }

            Performance.markStart(CONST.TIMING.OPEN_REPORT_SEARCH);
            Timing.start(CONST.TIMING.OPEN_REPORT_SEARCH);

            const backTo = Navigation.getActiveRoute();

            if (isTransactionGroupListItemType(item)) {
                Navigation.navigate(ROUTES.SEARCH_MONEY_REQUEST_REPORT.getRoute({reportID, backTo}));
                return;
            }

            // If we're trying to open a legacy transaction without a transaction thread, let's create the thread and navigate the user
            if (isTransactionItem && reportID === CONST.REPORT.UNREPORTED_REPORT_ID) {
                const generatedReportID = generateReportID();
                updateSearchResultsWithTransactionThreadReportID(hash, item.transactionID, generatedReportID);
                Navigation.navigate(
                    ROUTES.SEARCH_REPORT.getRoute({
                        reportID: generatedReportID,
                        backTo,
                        moneyRequestReportActionID: item.moneyRequestReportActionID,
                        transactionID: item.transactionID,
                    }),
                );
                return;
            }

            if (isReportActionListItemType(item)) {
                const reportActionID = item.reportActionID;
                Navigation.navigate(ROUTES.SEARCH_REPORT.getRoute({reportID, reportActionID, backTo}));
                return;
            }

            Navigation.navigate(ROUTES.SEARCH_REPORT.getRoute({reportID, backTo}));
        },
        [hash, isMobileSelectionModeEnabled, toggleTransaction],
    );

    const onViewableItemsChanged = useCallback(
        ({viewableItems}: {viewableItems: ViewToken[]}) => {
            const isFirstItemVisible = viewableItems.at(0)?.index === 1;
            // If the user is still loading the search results, or if they are scrolling down, don't refresh the search results
            if (shouldShowLoadingState || !isFirstItemVisible) {
                return;
            }

            // This line makes sure the app refreshes the search results when the user scrolls to the top.
            // The backend sends items in parts based on the offset, with a limit on the number of items sent (pagination).
            // As a result, it skips some items, for example, if the offset is 100, it sends the next items without the first ones.
            // Therefore, when the user scrolls to the top, we need to refresh the search results.
            setOffset(0);
        },
        [shouldShowLoadingState],
    );

    const isChat = type === CONST.SEARCH.DATA_TYPES.CHAT;
    const isTask = type === CONST.SEARCH.DATA_TYPES.TASK;
    const canSelectMultiple = !isChat && !isTask && (!isSmallScreenWidth || isMobileSelectionModeEnabled);
    const ListItem = getListItem(type, status, groupBy);
    const sortedSelectedData = useMemo(
        () =>
            getSortedSections(type, status, data, sortBy, sortOrder, groupBy).map((item) => {
                const baseKey = isChat
                    ? `${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${(item as ReportActionListItemType).reportActionID}`
                    : `${ONYXKEYS.COLLECTION.TRANSACTION}${(item as TransactionListItemType).transactionID}`;

                // Check if the base key matches the newSearchResultKey (TransactionListItemType)
                const isBaseKeyMatch = baseKey === newSearchResultKey;

                // Check if any transaction within the transactions array (TransactionGroupListItemType) matches the newSearchResultKey
                const isAnyTransactionMatch =
                    !isChat &&
                    (item as TransactionGroupListItemType)?.transactions?.some((transaction) => {
                        const transactionKey = `${ONYXKEYS.COLLECTION.TRANSACTION}${transaction.transactionID}`;
                        return transactionKey === newSearchResultKey;
                    });

                // Determine if either the base key or any transaction key matches
                const shouldAnimateInHighlight = isBaseKeyMatch || isAnyTransactionMatch;

                return mapToItemWithAdditionalInfo(item, selectedTransactions, canSelectMultiple, shouldAnimateInHighlight);
            }),
        [type, status, data, sortBy, sortOrder, groupBy, isChat, newSearchResultKey, selectedTransactions, canSelectMultiple],
    );

    const hasErrors = Object.keys(searchResults?.errors ?? {}).length > 0 && !isOffline;

    const fetchMoreResults = useCallback(() => {
        if (!searchResults?.search?.hasMoreResults || shouldShowLoadingState || shouldShowLoadingMoreItems) {
            return;
        }
        setOffset(offset + CONST.SEARCH.RESULTS_PAGE_SIZE);
    }, [offset, searchResults?.search?.hasMoreResults, shouldShowLoadingMoreItems, shouldShowLoadingState]);

    const toggleAllTransactions = useCallback(() => {
        const areItemsGrouped = !!groupBy;
        const totalSelected = Object.keys(selectedTransactions).length;

        if (totalSelected > 0) {
            clearSelectedTransactions();
            return;
        }

        if (areItemsGrouped) {
            setSelectedTransactions(
                Object.fromEntries(
                    (data as TransactionGroupListItemType[]).flatMap((item) =>
                        item.transactions.filter((t) => !isTransactionPendingDelete(t)).map((transactionItem) => mapTransactionItemToSelectedEntry(transactionItem, reportActionsArray)),
                    ),
                ),
                data,
            );

            return;
        }

        setSelectedTransactions(
            Object.fromEntries(
                (data as TransactionListItemType[])
                    .filter((t) => !isTransactionPendingDelete(t))
                    .map((transactionItem) => mapTransactionItemToSelectedEntry(transactionItem, reportActionsArray)),
            ),
            data,
        );
    }, [clearSelectedTransactions, data, groupBy, reportActionsArray, selectedTransactions, setSelectedTransactions]);

    const onLayout = useCallback(() => handleSelectionListScroll(sortedSelectedData, searchListRef.current), [handleSelectionListScroll, sortedSelectedData]);

    if (shouldShowLoadingState) {
        return (
            <SearchRowSkeleton
                shouldAnimate
                containerStyle={shouldUseNarrowLayout && styles.searchListContentContainerStyles}
            />
        );
    }

    if (searchResults === undefined) {
        Log.alert('[Search] Undefined search type');
        return <FullPageOfflineBlockingView>{null}</FullPageOfflineBlockingView>;
    }

    if (hasErrors) {
        return (
            <View style={[shouldUseNarrowLayout ? styles.searchListContentContainerStyles : styles.mt3, styles.flex1]}>
                <FullPageErrorView
                    shouldShow
                    subtitleStyle={styles.textSupporting}
                    title={translate('errorPage.title', {isBreakLine: shouldUseNarrowLayout})}
                    subtitle={translate('errorPage.subtitle')}
                />
            </View>
        );
    }

    const visibleDataLength = data.filter((item) => item.pendingAction !== CONST.RED_BRICK_ROAD_PENDING_ACTION.DELETE || isOffline).length;
    if (shouldShowEmptyState(isDataLoaded, visibleDataLength, searchResults.search.type)) {
        return (
            <View style={[shouldUseNarrowLayout ? styles.searchListContentContainerStyles : styles.mt3, styles.flex1]}>
                <EmptySearchView
                    hash={hash}
                    type={type}
                    groupBy={groupBy}
                    hasResults={searchResults.search.hasResults}
                />
            </View>
        );
    }

    const onSortPress = (column: SearchColumnType, order: SortOrder) => {
        const newQuery = buildSearchQueryString({...queryJSON, sortBy: column, sortOrder: order});
        navigation.setParams({q: newQuery});
    };

    const shouldShowYear = shouldShowYearUtil(searchResults?.data);
    const {shouldShowAmountInWideColumn, shouldShowTaxAmountInWideColumn} = getWideAmountIndicators(searchResults?.data);
    const shouldShowSorting = !Array.isArray(status) && !groupBy;
    const shouldShowTableHeader = isLargeScreenWidth && !isChat;

    return (
        <SearchScopeProvider isOnSearch>
            <SearchList
                ref={searchListRef}
                data={sortedSelectedData}
                ListItem={ListItem}
                onSelectRow={openReport}
                onCheckboxPress={toggleTransaction}
                onAllCheckboxPress={toggleAllTransactions}
                canSelectMultiple={canSelectMultiple}
                shouldPreventLongPressRow={isChat || isTask}
                SearchTableHeader={
                    !shouldShowTableHeader ? undefined : (
                        <SearchTableHeader
                            canSelectMultiple={canSelectMultiple}
                            data={searchResults?.data}
                            metadata={searchResults?.search}
                            onSortPress={onSortPress}
                            sortOrder={sortOrder}
                            sortBy={sortBy}
                            shouldShowYear={shouldShowYear}
                            isAmountColumnWide={shouldShowAmountInWideColumn}
                            isTaxAmountColumnWide={shouldShowTaxAmountInWideColumn}
                            shouldShowSorting={shouldShowSorting}
                        />
                    )
                }
                contentContainerStyle={[contentContainerStyle, styles.pb3]}
                containerStyle={[styles.pv0, type === CONST.SEARCH.DATA_TYPES.CHAT && !isSmallScreenWidth && styles.pt3]}
                shouldPreventDefaultFocusOnSelectRow={!canUseTouchScreen()}
                onScroll={onSearchListScroll}
                onEndReachedThreshold={0.75}
                onEndReached={fetchMoreResults}
                ListFooterComponent={
                    shouldShowLoadingMoreItems ? (
                        <SearchRowSkeleton
                            shouldAnimate
                            fixedNumItems={5}
                        />
                    ) : undefined
                }
                queryJSON={queryJSON}
                onViewableItemsChanged={onViewableItemsChanged}
                onLayout={onLayout}
                isMobileSelectionModeEnabled={isMobileSelectionModeEnabled}
            />
        </SearchScopeProvider>
    );
}

Search.displayName = 'Search';

export type {SearchProps};
export default Search;
