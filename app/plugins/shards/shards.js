'use strict';

angular.module('shards', ['sql', 'events'])
  .factory('ShardDetail', function (SQLQuery, queryResultToObjects, $q) {
    var service = {};
    var stmt = 'SELECT shards.id, size, min_lucene_version, num_docs, orphan_partition, ' +
      'state, routing_state, relocating_node, primary, ' +
      'partitions.values ' +
      'FROM sys.shards AS shards ' +
      'LEFT JOIN information_schema.table_partitions AS partitions ' +
      'ON shards.table_name = partitions.table_name ' +
      'AND shards.partition_ident = partitions.partition_ident ' +
      'WHERE shards.node[\'id\']=$1 ' +
      'AND shards.schema_name=$2 ' +
      'AND shards.table_name=$3 ' +
      'AND shards.partition_ident=$4 ' +
      'AND shards.id=$5 ';

    var cols = ['id', 'size', 'min_lucene_version', 'num_docs', 'orphan_partition',
          'state', 'routing_state', 'relocating_node', 'primary', 'values'];

    service.get = function (node_id, schema_name, table_name, partition_ident, shard_id) {
      if (node_id === 'unassigned') {
        node_id = null;
      }
      var deferred = $q.defer(),
        promise = deferred.promise;
      SQLQuery.execute(stmt, [node_id, schema_name, table_name, partition_ident, shard_id], false, false, true, true)
        .then(function (query) {
          var result = queryResultToObjects(query, cols);
          deferred.resolve(result);
        },function () {
          deferred.reject();
        });

      return promise;
    };

    return service;
  })
  .factory('NodeDetail', function (SQLQuery, queryResultToObjects, $q) {
    var service = {};
    var stmt = 'SELECT name, id, hostname, rest_url, version[\'number\'] ' +
      'FROM sys.nodes ' +
      'WHERE id=$1';

    var cols = ['name', 'id', 'hostname', 'rest_url', 'version'];

    service.get = function (node_id) {
      var deferred = $q.defer(),
        promise = deferred.promise;
      SQLQuery.execute(stmt, [node_id], false, false, true, true)
        .then(function (query) {
          var result = queryResultToObjects(query, cols);
          deferred.resolve(result);
        },function () {
          deferred.reject();
        });

      return promise;
    };

    return service;
  })
  .factory('ShardsIntervalService', function (SQLQuery, queryResultToObjects, $timeout, $q, ClusterEventsHandler) {
    var shardsIntervalService = {};

    var stmt = 'SELECT shards.id, table_name, schema_name, partition_ident, ' +
      'state, primary, ' +
      'format(\'%s.%s\', schema_name, table_name) AS fqn, ' +
      'format(\'%s.%s.%s\', schema_name, table_name, partition_ident) AS key, ' +
      'nodes.id AS node_id, nodes.name AS node_name ' +
      'FROM sys.shards ' +
      'RIGHT JOIN sys.nodes AS nodes ' +
      'ON shards.node[\'id\'] = nodes.id ' +
      'ORDER BY key, node_id, shards.id';

    var cols = ['id', 'table_name', 'schema_name',
       'partition_ident', 'state', 'primary',
       'fqn', 'key', 'node_id', 'node_name'];

    var poll = function () {
      SQLQuery.execute(stmt, {}, false, false, true, false)
        .then(function (response) {
          shardsIntervalService.response = queryResultToObjects(response, cols);
        }).catch(function () {
          shardsIntervalService.response = [];
        }).finally(function () {
          ClusterEventsHandler.trigger('SHARD_QUERY_DONE');
        });
    };

    shardsIntervalService.refresh = poll;
    return shardsIntervalService;
  })
  .filter('shardStateClass', function () {
    return function (state, primary) {
      var cssClass = '';

      if (primary === true) {
        cssClass = 'cr-shard-primary ';
      }

      switch (state) {
      case 'CREATED':
      case 'STARTED':
      case 'RELOCATED':
        return cssClass + 'cr-shard-state--green';
      case 'INITIALIZING':
      case 'POST_RECOVERY':
        return cssClass + 'cr-shard-state--yellow';
      case 'RECOVERING':
        return cssClass + 'cr-shard-state--red';
      case 'UNASSIGNED':
        return cssClass + 'cr-shard-state--grey';
      default:
        return cssClass + 'cr-shard-state--grey';
      }
    };
  })
  .controller('ShardsController', function ($scope, $q, ShardDetail, NodeDetail,
    ShardsIntervalService, $location, $filter, $rootScope, $interval, $timeout,
    ClusterEventsHandler) {
    var nodeTimeout, shardTimeout;
    var shardInterval;

    $scope.idOption = (localStorage.getItem('crate.shards.shard_id_on') || '1') === '1';

    $scope.response = [];
    $scope.selectedShard = '';

    $scope.selectShard = function (key) {
      $scope.selectedShard = key;
      $('.' + key).addClass('selected-shard');
    };

    $scope.unSelectShard = function (key) {
      $scope.selectedShard = '';
      $('.' + key).removeClass('selected-shard');
    };

    $scope.goToUrl = function (path) {
      $location.path(path);
    };


    $scope.showShardIds = function () {
      localStorage.setItem('crate.shards.shard_id_on', $scope.idOption ? '1' : '0');
    };

    function safeApply(scope, fn) {
      var phase = scope.$root.$$phase;
      if (phase == '$apply' || phase == '$digest') {
        scope.$eval(fn);
      } else {
        scope.$apply(fn);
      }
    }

    function setShardData(target, event) {
      var key = target.data('key');
      $scope.selectShard(key);
      // set tooltip data
      var tableKey = target.data('table');
      var nodeId = target.data('node');
      var shardId = target.data('id');

      var tableNameParts = tableKey.split('.');
      $q.when(ShardDetail.get(nodeId, tableNameParts[0], tableNameParts[1], tableNameParts[2], shardId))
        .then(function (shard) {
          $scope.tooltipData = shard[0];
          if ($scope.tooltipData) {
            $scope.tooltipData.partition_ident = tableNameParts[2];
          }
          $scope.tooltipError = false;
        }).catch(function () {
          $scope.tooltipError = true;
        }).finally(function () {
          $scope.tooltipLoading = false;
        });

      $scope.pageX = event.pageX;
      $scope.pageY = event.pageY;
      $scope.displayTooltip = true;
    }

    function setNodeData(target, event) {

      if (target.data('node') === 'unassigned') {
        //don't display tooltip for unassigned node
        return;
      }

      $q.when(NodeDetail.get(target.data('node')))
        .then(function (node) {
          $scope.tooltipData = node[0];
          $scope.tooltipError = false;
        }).catch(function () {
          $scope.tooltipError = true;
        }).finally(function () {
          $scope.tooltipLoading = false;
        });

      $scope.pageX = event.pageX;
      $scope.pageY = event.pageY;
      $scope.displayTooltip = true;
    }

    $('tbody').mousemove(function (event) {
        safeApply($scope, function () {
          if ($scope.displayTooltip) {
            $scope.pageX = event.pageX;
            $scope.pageY = event.pageY;
          }
        });
      })
      .mouseover(function (event) {
        $scope.tooltipLoading = true;
        var target = $(event.target);
        if (target.hasClass('shard-number') && !target.parent().hasClass('empty-shard')) {
          target = target.parent();
          $scope.isShard = true;
          shardTimeout = $timeout(function () {
            safeApply($scope, function () {
              setShardData(target, event);
            });
          }, 50);


        } else if (target.hasClass('shard-item') && !target.hasClass('empty-shard')) {
          $scope.isShard = true;
          shardTimeout = $timeout(function () {
            safeApply($scope, function () {
              setShardData(target, event);
            });
          }, 50);

        } else if (target.hasClass('shards-table-node') && !target.hasClass('unassigned')) {
          $scope.isShard = false;
          nodeTimeout = $timeout(function () {
            safeApply($scope, function () {
              setNodeData(target, event);
            });
          }, 50);
        } else {
          $scope.displayTooltip = false;
          return;
        }
      })
      .mouseout(function (event) {
        $scope.displayTooltip = false;
        $scope.tooltipData = {};
        $scope.pageX = event.pageX;
        $scope.pageY = event.pageY;
        var target = $(event.target);
        if (target.hasClass('shard-number') && !target.parent().hasClass('empty-shard')) {
          target = target.parent();
          $scope.unSelectShard(target.data('key'));
        } else if (target.hasClass('shard-item') && !target.hasClass('empty-shard')) {
          $scope.unSelectShard(target.data('key'));
        }

        if (nodeTimeout) {
          $timeout.cancel(nodeTimeout);
        }
        if (shardTimeout) {
          $timeout.cancel(shardTimeout);
        }
        return;
      });

    function sortObjectByKeys(dict) {
      var keys = Object.keys(dict),
        i, len = keys.length,
        new_object = {};

      keys.sort();

      for (i = 0; i < len; i++) {
        var k = keys[i];
        new_object[k] = dict[k];
      }
      return new_object;
    }

    function shardExists(shards, id) {
      var filteredShards = [];
      filteredShards = shards.filter(function (el) {
        if (el.id === id) {
          return true;
        }
      });

      return filteredShards.length !== 0;
    }

    ClusterEventsHandler.register('SHARD_QUERY_DONE', 'ShardsController', function () {
      $scope.response = ShardsIntervalService.response;
      $scope.formatShardData();
    });

    $scope.formatShardData = function () {
      $scope.tables = {};
      $scope.tables_partitions = [];
      $scope.schemas = {};
      $scope.shards = {};
      $scope.empty = $scope.response.length === 0 ? true : false;
      $scope.colSpan = 0;
      var old_id = 0;

      var formatted_response = {};

      $scope.response.forEach(function (obj) {

        if (!obj.node_id) {
          obj.node_id = 'unassigned';
        }

        if (!formatted_response[obj.node_id]) {
          formatted_response[obj.node_id] = {};
        }

        var nodeFormat = formatted_response[obj.node_id];

        if (!nodeFormat.shards_by_table) {
          nodeFormat.shards_by_table = {};
        }
        if (obj.key !== 'null.null.null') {
          if (!nodeFormat.shards_by_table[obj.key]) {
            nodeFormat.shards_by_table[obj.key] = {};
          }

          if (!nodeFormat.shards_by_table[obj.key].shards) {
            nodeFormat.shards_by_table[obj.key].shards = [];
          }

          // add missing shards as empty space
          while (obj.id > old_id) {
            if (!shardExists(nodeFormat.shards_by_table[obj.key].shards, old_id)) {
              nodeFormat.shards_by_table[obj.key].shards.push({
                'state_class': 'empty-shard',
                'id': old_id,
              });
            }
            old_id += 1;
          }
          // re-init old_id
          old_id = 0;

          if (nodeFormat.shards_by_table[obj.key].shards[obj.id]) {
            // if there is already a shard with the same id, 
            // we increase the number of replicas.
            // This will occur in the case of unassigned shards of the same id
            var replicas = nodeFormat.shards_by_table[obj.key].shards[obj.id].replicas;
            nodeFormat.shards_by_table[obj.key].shards[obj.id].replicas = replicas == undefined ? 1 : replicas + 1;
          } else {
            // if the shard is not already in the list we will add it
            var shard_key = [obj.key, obj.id].join('-').replace(/\./g, '-');
            nodeFormat.shards_by_table[obj.key].shards.push({
              'state_class': $filter('shardStateClass')(obj.state, obj.primary) + ' ' + shard_key,
              'key': shard_key,
              'id': obj.id,
            });
          }
          nodeFormat.shards_by_table[obj.key].table_name = obj.table_name;
          nodeFormat.shards_by_table[obj.key].schema_name = obj.schema_name;
          nodeFormat.shards_by_table[obj.key].partition_ident = obj.partition_ident;
          nodeFormat.shards_by_table[obj.key].fqn = obj.fqn;

        }
        if (obj.node_name) {
          nodeFormat.node_info = {
            'name': obj.node_name,
            'id': obj.node_id
          };
        } else {
          nodeFormat.node_info = {
            'name': 'UNASSIGNED'
          };
          nodeFormat.html = '<div> Unassigned Shards</div>';
        }

        return formatted_response;
      });
      $scope.shards = formatted_response;
      $scope.response.forEach(function (el) {
        if ($scope.tables_partitions.indexOf(el.key) === -1) {
          $scope.tables_partitions.push(el.key);
        }
      });

      $scope.tables_partitions.forEach(function (fqn) {
        if (fqn !== 'null.null.null') {
          //make sure all nodes have the same number of columns
          Object.keys(formatted_response).forEach(function (node_id) {
            var shards_by_table = formatted_response[node_id].shards_by_table;

            if (!shards_by_table) {
              shards_by_table = {};
            }
            if (!shards_by_table[fqn]) {
              shards_by_table[fqn] = {};
            }
            if (!shards_by_table[fqn].shards) {
              shards_by_table[fqn].shards = [];
            }
          });


          var fqnParts = fqn.split('.');
          var schemaName = fqnParts[0];
          var schemaTableName = fqn.split('.', 2).join('.');

          // construct table list 
          if (!$scope.schemas[schemaName]) {
            $scope.schemas[schemaName] = 1;
          } else {
            $scope.schemas[schemaName] += 1;
          }

          // construct table list 
          if (!$scope.tables[schemaTableName]) {
            $scope.tables[schemaTableName] = 1;
          } else {
            $scope.tables[schemaTableName] += 1;
          }
        }
      });

      // sort each node column by fqn for consistency
      Object.keys(formatted_response).forEach(function (node_id) {
        formatted_response[node_id].shards_by_table = sortObjectByKeys(formatted_response[node_id].shards_by_table);
      });

      Object.keys($scope.schemas).forEach(function (key) {
        if (key != 'null') {
          $scope.colSpan += $scope.schemas[key];
        }
      });
    };
    ShardsIntervalService.refresh();
    shardInterval = $interval(ShardsIntervalService.refresh, 5000);

    $scope.$on('$destroy', function () {
      ClusterEventsHandler.remove('SHARD_QUERY_DONE', 'ShardsController');
      $interval.cancel(shardInterval);
    });
  })
  .directive('shardWrapper', function () {
    return {
      restrict: 'E',
      scope: {
        length: '=length'
      },
      link: function (scope, element) {
        //update number of shards by row
        var numberOfShardsPerColumn = Math.max(3, Math.floor(Math.sqrt(scope.length)));
        element.css({
          'width': numberOfShardsPerColumn * (17 + 5) + 'px'
        });
      }
    };
  })
  .run(function ($window, NavigationService, $translatePartialLoader, $filter, $rootScope, $translate) {

    $translatePartialLoader.addPart('./static/plugins/shards');
    $translate.refresh();
    var iconSrc = 'static/plugins/shards/static/icons/icon-shards.svg';
    var url = '/shards';
    var position = 31;

    NavigationService.addNavBarElement(iconSrc, $filter('translate', 'NAVIGATION.PRIVILEGES'), url, position);

    // Update Navbar Elements if Language Changes
    $rootScope.$on('$translateChangeSuccess', function () {
      $translate('NAVIGATION.SHARDS').then(function (translation) {
        NavigationService.updateNavBarElement(url, translation);
      });
    });
  });
